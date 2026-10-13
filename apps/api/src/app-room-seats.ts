import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { apps, spaces, userProfiles } from "@cohub/db";
import { AppRoomStore, type AppRoomSeat } from "@cohub/infra/app-room";
import type { ActorModel } from "@cohub/protocol/provenance";
import type { RealtimeRoomHistoryEvent } from "@cohub/protocol/realtime";
import {
  type AppRoomRecord,
  createAppRoom,
  createAppRoomInvite,
  deriveAppRoomUserKey,
  deriveHostedSeatId,
  getAppRoomById,
  serializeAppRoom,
  verifyAppRoomInvite,
} from "./app-rooms.js";
import { db } from "./db/index.js";
import { createAppPublicUrl } from "./lib/app-public-url.js";
import { getExecutionPrincipal, useAccountPrincipal } from "./lib/middleware.js";
import { resolveRequestActor } from "./lib/request-actor.js";
import { getRequestSource } from "./lib/request-source.js";
import { hasPermission } from "./permissions.js";
import { redisCommandClient } from "./redis.js";

export const HOSTED_SEAT_DEFAULT_IDLE_SECONDS = 30 * 60;
export const HOSTED_SEAT_MIN_IDLE_SECONDS = 60;
export const HOSTED_SEAT_MAX_IDLE_SECONDS = 24 * 60 * 60;
export const HOSTED_EVENTS_MAX_WAIT_MS = 25_000;
const HOSTED_EVENTS_POLL_MS = 1_000;
const HOSTED_EVENTS_MAX_TYPES = 16;

const store = new AppRoomStore(redisCommandClient);

export class HostedRoomError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 410, readonly code: string, message: string) {
    super(message);
    this.name = "HostedRoomError";
  }
}

const notInRoom = () => new HostedRoomError(404, "ROOM_SEAT_NOT_FOUND", "You are not in this room. Join it with an invite first.");

export type HostedCaller = {
  userUuid: string;
  kind: "agent" | "cli";
  model: ActorModel | null;
  subject: string;
};

export async function resolveHostedCaller(c: Context): Promise<HostedCaller | Response> {
  const user = useAccountPrincipal(c);
  if (user instanceof Response) return user;
  const actor = await resolveRequestActor(c);
  const sessionId = getExecutionPrincipal(c)?.sessionId ?? getRequestSource(c)?.sessionId;
  const agent = actor.kind === "agent";
  return {
    userUuid: user.uuid,
    kind: agent ? "agent" : "cli",
    model: agent ? actor.model ?? null : null,
    subject: agent ? `session:${sessionId ?? "unknown"}` : "cli",
  };
}

const seatOf = (roomId: string, caller: HostedCaller): AppRoomSeat => {
  const participantId = deriveHostedSeatId(roomId, caller.userUuid, caller.subject);
  return { roomId, participantId, owner: `seat:${participantId}` };
};

async function publishedApp(appId: string) {
  const [app] = await db.select({ id: apps.id, status: apps.status, spaceId: apps.spaceId, slug: apps.slug }).from(apps).where(eq(apps.id, appId)).limit(1);
  return app?.status === "published" ? app : null;
}

async function liveRoom(roomId: string) {
  const room = await getAppRoomById(roomId);
  if (!room) throw new HostedRoomError(410, "ROOM_EXPIRED", "This room has expired.");
  return room;
}

async function requireSeat(roomId: string, caller: HostedCaller) {
  const seat = seatOf(roomId, caller);
  const status = await store.renew(seat);
  if (status === "expired") throw new HostedRoomError(410, "ROOM_EXPIRED", "This room has expired.");
  if (status !== "active") throw notInRoom();
  return seat;
}

async function view(room: AppRoomRecord, seat: AppRoomSeat) {
  const snapshot = await store.snapshot(room.id);
  return { room: serializeAppRoom(room), participantId: seat.participantId, ...snapshot };
}

const idleSecondsOf = (value: unknown) => {
  if (value === undefined) return HOSTED_SEAT_DEFAULT_IDLE_SECONDS;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < HOSTED_SEAT_MIN_IDLE_SECONDS || seconds > HOSTED_SEAT_MAX_IDLE_SECONDS) {
    throw new HostedRoomError(400, "INVALID_IDLE", `idleSeconds must be between ${HOSTED_SEAT_MIN_IDLE_SECONDS} and ${HOSTED_SEAT_MAX_IDLE_SECONDS}`);
  }
  return seconds;
};

export async function joinRoom(caller: HostedCaller, input: { invite: string; presence?: Record<string, unknown> | null; idleSeconds?: unknown }) {
  const invite = verifyAppRoomInvite(input.invite);
  if (!invite) throw new HostedRoomError(403, "INVALID_INVITE", "This invite is invalid or has expired.");
  const room = await liveRoom(invite.roomId);
  if (room.appId !== invite.appId || !(await publishedApp(room.appId))) {
    throw new HostedRoomError(410, "ROOM_EXPIRED", "This room's App is no longer published.");
  }
  const seat = seatOf(room.id, caller);
  const result = await store.claim({
    roomId: room.id,
    participantId: seat.participantId,
    owner: seat.owner,
    userKey: deriveAppRoomUserKey(room.id, caller.userUuid),
    kind: caller.kind,
    model: caller.model,
    leaseSeconds: idleSecondsOf(input.idleSeconds),
    hosted: true,
    ...(input.presence !== undefined ? { presence: input.presence } : {}),
  });
  await store.announce({
    roomId: room.id,
    type: result.isNew ? "realtime.room.member.joined" : "realtime.room.presence.updated",
    payload: { roomId: room.id, member: result.member },
  });
  return view(room, seat);
}

export async function getRoom(caller: HostedCaller, roomId: string) {
  const seat = await requireSeat(roomId, caller);
  return view(await liveRoom(roomId), seat);
}

export async function publishToRoom(caller: HostedCaller, roomId: string, input: { type: string; data: unknown }) {
  const seat = seatOf(roomId, caller);
  const { sequence, eventId } = await store.publish(seat, { event: input.type, data: input.data, record: true });
  return { sequence, eventId };
}

export async function setRoomPresence(caller: HostedCaller, roomId: string, presence: Record<string, unknown> | null) {
  const { member, sequence } = await store.setPresence(seatOf(roomId, caller), presence);
  return { member, sequence };
}

export async function inviteToRoom(caller: HostedCaller, roomId: string, expiresInSeconds?: number) {
  await requireSeat(roomId, caller);
  return createAppRoomInvite(await liveRoom(roomId), expiresInSeconds);
}

export async function leaveRoom(caller: HostedCaller, roomId: string) {
  return { left: Boolean(await store.release(seatOf(roomId, caller))) };
}

const typeMatcher = (types: string[]) => {
  if (types.length === 0) return () => true;
  if (types.length > HOSTED_EVENTS_MAX_TYPES) throw new HostedRoomError(400, "INVALID_TYPES", `At most ${HOSTED_EVENTS_MAX_TYPES} type patterns.`);
  const patterns = types.map((type) => new RegExp(`^${type.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`));
  return (type: string) => patterns.some((pattern) => pattern.test(type));
};

export async function readRoomEvents(
  caller: HostedCaller,
  roomId: string,
  input: { after?: number; types: string[]; waitMs: number; limit?: number; signal?: AbortSignal },
) {
  const seat = await requireSeat(roomId, caller);
  if (input.limit !== undefined && input.limit <= 0) return { events: [], cursor: input.after ?? 0, truncated: false };
  const matches = typeMatcher(input.types);
  const deadline = Date.now() + Math.min(Math.max(0, input.waitMs), HOSTED_EVENTS_MAX_WAIT_MS);
  const tag = (event: RealtimeRoomHistoryEvent) => ({ ...event, self: event.sender.participantId === seat.participantId });
  let cursor = input.after ?? (input.waitMs > 0 ? (await store.history(roomId, { limit: 1 })).cursor : undefined);
  let truncated = false;
  const events: ReturnType<typeof tag>[] = [];
  for (;;) {
    const page = await store.history(roomId, { after: cursor, limit: input.limit === undefined ? undefined : input.limit - events.length });
    truncated ||= page.truncated;
    events.push(...page.events.filter((event) => matches(event.type)).map(tag));
    const advanced = page.cursor !== cursor;
    cursor = page.cursor;
    const woken = events.some((event) => !event.self);
    if (woken || events.length >= (input.limit ?? Number.POSITIVE_INFINITY) || input.waitMs <= 0 || Date.now() >= deadline || input.signal?.aborted) break;
    if (advanced && page.events.length > 0) continue;
    await new Promise((resolve) => setTimeout(resolve, HOSTED_EVENTS_POLL_MS));
  }
  return { events, cursor: cursor ?? 0, truncated };
}

export async function createRoom(c: Context, input: { appId: string; code?: unknown; expiresInSeconds?: unknown; maxParticipants?: unknown; seatPerUser?: unknown }) {
  const user = useAccountPrincipal(c);
  if (user instanceof Response) return user;
  const app = await publishedApp(input.appId);
  if (!app) throw new HostedRoomError(404, "APP_NOT_FOUND", "App not found, or not published.");
  if (!(await hasPermission(user, "app.manage", { spaceId: app.spaceId }))) {
    throw new HostedRoomError(403, "FORBIDDEN", "Creating a room needs permission to manage this App.");
  }
  const room = await createAppRoom({ ...input, appId: app.id });
  const [identity] = await db
    .select({ spaceSlug: spaces.slug, ownerUsername: userProfiles.username })
    .from(spaces)
    .leftJoin(userProfiles, eq(userProfiles.userUuid, spaces.userUuid))
    .where(eq(spaces.id, app.spaceId))
    .limit(1);
  const appUrl = identity?.spaceSlug && identity.ownerUsername
    ? createAppPublicUrl({ ownerUsername: identity.ownerUsername, spaceSlug: identity.spaceSlug, appSlug: app.slug })
    : null;
  return {
    room: serializeAppRoom(room),
    ...createAppRoomInvite(room),
    url: appUrl ? `${appUrl}?room=${encodeURIComponent(room.code)}` : null,
  };
}
