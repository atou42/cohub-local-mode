import type { RealtimeRoomDescriptor } from "@cohub/protocol/realtime";
import { AppRoomStore, APP_ROOM_CONNECTION_LEASE_SECONDS, type AppRoomSeat, type AppRoomSeatStatus } from "@cohub/infra/app-room";
import { authorizeAppRoom, authorizeHostedRoom } from "./api-client.js";
import { redisCommandClient } from "./redis.js";

type RoomConnection = {
  connectionId: string;
  userId?: string;
  token?: string;
  appRooms: Map<string, { participantId: string; ticket: string; room: RealtimeRoomDescriptor; hosted?: boolean }>;
};

export const appRoomStore = new AppRoomStore(redisCommandClient);

export const APP_ROOM_MAX_PENDING_OPS = 256;
export const APP_ROOM_MAX_PRESENCE_RATE = 30;

export type AppRoomPresenceRate = { startedAt: number; count: number };

/**
 * Presence writes touch Redis on every call, so they get a connection-level
 * window of their own. Unlike publishes there is no Redis-side rate script,
 * and unlike Board awareness they cannot be dropped silently: the caller is
 * waiting on a request ack, so an over-rate update is rejected instead.
 */
export function consumeAppRoomPresenceRate(rate: AppRoomPresenceRate, now = Date.now()): boolean {
  if (now - rate.startedAt >= 1_000) {
    rate.startedAt = now;
    rate.count = 1;
    return true;
  }
  rate.count += 1;
  return rate.count <= APP_ROOM_MAX_PRESENCE_RATE;
}

export const connectionSeat = (ctx: RoomConnection, roomId: string): AppRoomSeat | null => {
  const membership = ctx.appRooms.get(roomId);
  return membership ? { roomId, participantId: membership.participantId, owner: membership.hosted ? `seat:${membership.participantId}` : ctx.connectionId } : null;
};

export const isHostedRoomMembership = (ctx: RoomConnection, roomId: string) => ctx.appRooms.get(roomId)?.hosted === true;

/**
 * Claims the seat only. The caller subscribes to the room next and then reads the
 * snapshot: an unseated connection must never enter the public routing table, yet
 * the snapshot must be taken after subscribing so no event slips through the gap.
 */
export async function claimAppRoomSeat(ctx: RoomConnection, input: { roomId: string; ticket: string; instanceId?: string }) {
  if (!ctx.token || !ctx.userId) throw new Error("authentication required");
  const admission = await authorizeAppRoom({ authToken: ctx.token, roomId: input.roomId, ticket: input.ticket });
  const result = await appRoomStore.claim({
    roomId: input.roomId,
    participantId: admission.participantId,
    owner: ctx.connectionId,
    userKey: admission.userKey,
    kind: "user",
    instanceId: input.instanceId,
    leaseSeconds: APP_ROOM_CONNECTION_LEASE_SECONDS,
  });
  ctx.appRooms.set(input.roomId, { participantId: result.member.participantId, ticket: input.ticket, room: admission.room });
  return { ...result, room: admission.room };
}

export const isHostedRoomTicket = (token: string) => {
  try {
    const body = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { typ?: unknown };
    return body.typ === "hosted_room_ticket";
  } catch {
    return false;
  }
};

export async function attachHostedRoomSeat(ctx: RoomConnection, input: { roomId: string; ticket: string }) {
  if (!ctx.token || !ctx.userId) throw new Error("authentication required");
  if (ctx.appRooms.has(input.roomId)) throw new Error("room is already connected");
  const admission = await authorizeHostedRoom({ authToken: ctx.token, ...input });
  const snapshot = await appRoomStore.snapshot(input.roomId);
  const member = snapshot.members.find((item) => item.participantId === admission.participantId);
  if (!member) throw new Error("hosted room seat is no longer active");
  ctx.appRooms.set(input.roomId, { participantId: admission.participantId, ticket: input.ticket, room: admission.room, hosted: true });
  return { ...admission, member, isNew: false, droppedPublications: false };
}

export async function releaseAppRoomSeat(ctx: RoomConnection, roomId: string, options: { releaseHosted?: boolean } = {}) {
  const seat = connectionSeat(ctx, roomId);
  const hosted = isHostedRoomMembership(ctx, roomId);
  ctx.appRooms.delete(roomId);
  return !seat || hosted && !options.releaseHosted ? null : appRoomStore.release(seat);
}

export async function renewAppRoomSeat(ctx: RoomConnection, roomId: string): Promise<AppRoomSeatStatus> {
  const seat = connectionSeat(ctx, roomId);
  return seat ? appRoomStore.renew(seat) : "revoked";
}
