import { randomUUID } from "node:crypto";
import type { ActorKind, ActorModel } from "@cohub/protocol/provenance";
import {
  getRealtimeRoom,
  getRealtimeRoomHistoryKey,
  getRealtimeRoomHistoryMetaKey,
  getRealtimeRoomLeasesKey,
  getRealtimeRoomMembersKey,
  getRealtimeRoomMetaKey,
  getRealtimeRoomRateKey,
  getRealtimeRoomSequenceKey,
  REALTIME_OUTBOUND_CHANNEL,
  REALTIME_ROOM_EVENT_NAME_PATTERN,
  REALTIME_ROOM_HISTORY_BYTES,
  REALTIME_ROOM_HISTORY_PAGE,
  REALTIME_ROOM_HISTORY_SIZE,
  REALTIME_ROOM_MAX_PAYLOAD_BYTES,
  type RealtimeEnvelope,
  type RealtimeRoomHistory,
  type RealtimeRoomHistoryEvent,
  type RealtimeRoomMember,
} from "@cohub/protocol/realtime";
import { ANNOUNCE, CLAIM_SEAT, LEAVE, PUBLISH, READ_HISTORY, RENEW, SET_PRESENCE, SNAPSHOT, SWEEP } from "./scripts.js";

export type AppRoomRedis = {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
};

export const APP_ROOM_CONNECTION_LEASE_SECONDS = 60;
export const APP_ROOM_MAX_EVENT_RATE = 2_000;
export const APP_ROOM_MAX_PRESENCE_BYTES = 2 * 1024;

export type AppRoomSeat = { roomId: string; participantId: string; owner: string };

export type AppRoomSeatStatus = "active" | "expired" | "revoked" | "superseded";

export type AppRoomErrorCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_EXPIRED"
  | "ROOM_FULL"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_EVENT"
  | "RESERVED_EVENT"
  | "ROOM_REQUEST_FAILED";

export class AppRoomError extends Error {
  constructor(readonly code: AppRoomErrorCode, message: string) {
    super(message);
    this.name = "AppRoomError";
  }
}

export class AppRoomSeatLostError extends Error {
  constructor(message: string, readonly status: Exclude<AppRoomSeatStatus, "active">) {
    super(message);
    this.name = "AppRoomSeatLostError";
  }
}

const SEAT_LOST: Record<number, [string, Exclude<AppRoomSeatStatus, "active">]> = {
  [-1]: ["room not found", "revoked"],
  [-2]: ["room expired", "expired"],
  [-3]: ["room membership is stale", "revoked"],
  [-5]: ["room membership is stale", "superseded"],
};

const seatError = (code: number) => {
  const lost = SEAT_LOST[code];
  if (lost) return new AppRoomSeatLostError(lost[0], lost[1]);
  if (code === -4) return new AppRoomError("RATE_LIMITED", "room event rate exceeded");
  return new AppRoomError("ROOM_REQUEST_FAILED", "room request failed");
};

const claimError = (code: number) => {
  if (code === -1) return new AppRoomError("ROOM_NOT_FOUND", "room not found");
  if (code === -2) return new AppRoomError("ROOM_EXPIRED", "room expired");
  if (code === -3) return new AppRoomError("ROOM_FULL", "room is full");
  return new AppRoomError("ROOM_REQUEST_FAILED", "room request failed");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const KINDS = new Set<ActorKind>(["user", "agent", "cli"]);

export const parseRoomMember = (raw: string): RealtimeRoomMember | null => {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.participantId !== "string" || typeof value.joinedAt !== "string") return null;
    const model = isRecord(value.model) && typeof value.model.id === "string"
      ? { provider: typeof value.model.provider === "string" ? value.model.provider : null, id: value.model.id }
      : null;
    return {
      participantId: value.participantId,
      joinedAt: value.joinedAt,
      presence: isRecord(value.presence) ? value.presence : null,
      kind: KINDS.has(value.kind as ActorKind) ? value.kind as ActorKind : "user",
      ...(typeof value.userKey === "string" ? { userKey: value.userKey } : {}),
      ...(model ? { model } : {}),
      ...(Array.isArray(value.publications) && value.publications.length > 0
        ? { publications: value.publications as RealtimeRoomMember["publications"] }
        : {}),
    };
  } catch {
    return null;
  }
};

const encodeJson = (value: unknown, limit: number, error: () => AppRoomError) => {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json, "utf8") > limit) throw error();
  return json;
};

type StreamEntry = [string, string[]];

const toHistoryEvent = ([id, fields]: StreamEntry): RealtimeRoomHistoryEvent | null => {
  const entry: Record<string, string> = {};
  for (let index = 0; index + 1 < fields.length; index += 2) entry[fields[index] as string] = fields[index + 1] as string;
  try {
    const meta = JSON.parse(entry.m ?? "") as { id: string; timestamp: number; type: string; clientEventId: string | null; sender: string };
    return {
      id: meta.id,
      timestamp: meta.timestamp,
      sequence: Number.parseInt(id, 10),
      type: meta.type,
      data: JSON.parse(entry.d ?? "null"),
      clientEventId: typeof meta.clientEventId === "string" ? meta.clientEventId : null,
      sender: { participantId: meta.sender },
    };
  } catch {
    return null;
  }
};

export class AppRoomStore {
  constructor(private readonly redis: AppRoomRedis) {}

  async claim(input: {
    roomId: string;
    participantId: string;
    owner: string;
    userKey: string;
    kind: ActorKind;
    model?: ActorModel | null;
    instanceId?: string;
    leaseSeconds: number;
    hosted?: boolean;
    presence?: Record<string, unknown> | null;
  }) {
    const result = await this.redis.eval(
      CLAIM_SEAT,
      3,
      getRealtimeRoomMetaKey(input.roomId),
      getRealtimeRoomMembersKey(input.roomId),
      getRealtimeRoomLeasesKey(input.roomId),
      input.participantId,
      input.owner,
      String(input.leaseSeconds),
      new Date().toISOString(),
      input.userKey,
      input.instanceId ?? "",
      input.kind,
      input.model ? JSON.stringify(input.model) : "",
      input.hosted ? "1" : "0",
      input.presence === undefined ? "" : encodeJson(input.presence, APP_ROOM_MAX_PRESENCE_BYTES, presenceTooLarge),
    ) as [number, number?, string?, number?, string[]?];
    const code = Number(result[0]);
    if (code !== 1) throw claimError(code);
    const member = parseRoomMember(result[2] ?? "");
    if (!member) throw new AppRoomError("ROOM_REQUEST_FAILED", "invalid room member");
    await this.announceLeft(input.roomId, result[4] ?? []);
    return { member, isNew: Number(result[1]) === 1, droppedPublications: Number(result[3]) === 1 };
  }

  async snapshot(roomId: string) {
    const result = await this.redis.eval(
      SNAPSHOT,
      3,
      getRealtimeRoomMembersKey(roomId),
      getRealtimeRoomLeasesKey(roomId),
      getRealtimeRoomSequenceKey(roomId),
    ) as [string?, number?];
    const members = (JSON.parse(result[0] ?? "[]") as unknown[]).flatMap((item) => {
      const member = parseRoomMember(JSON.stringify(item));
      return member ? [member] : [];
    });
    return { members, sequence: Number(result[1] ?? 0) };
  }

  async leave(seat: AppRoomSeat) {
    const result = await this.redis.eval(
      LEAVE,
      2,
      getRealtimeRoomMembersKey(seat.roomId),
      getRealtimeRoomLeasesKey(seat.roomId),
      seat.participantId,
      seat.owner,
    );
    return typeof result === "string" ? parseRoomMember(result) : null;
  }

  async renew(seat: AppRoomSeat, leaseSeconds = APP_ROOM_CONNECTION_LEASE_SECONDS): Promise<AppRoomSeatStatus> {
    const code = Number(await this.redis.eval(RENEW, 3, ...this.seatKeys(seat.roomId), seat.participantId, seat.owner, String(leaseSeconds)));
    return code === 1 ? "active" : (SEAT_LOST[code]?.[1] ?? "revoked");
  }

  async setPresence(seat: AppRoomSeat, presence: Record<string, unknown> | null, leaseSeconds = APP_ROOM_CONNECTION_LEASE_SECONDS) {
    const json = encodeJson(presence, APP_ROOM_MAX_PRESENCE_BYTES, presenceTooLarge);
    const result = await this.redis.eval(SET_PRESENCE, 3, ...this.seatKeys(seat.roomId), seat.participantId, seat.owner, String(leaseSeconds), json);
    if (typeof result !== "string") throw seatError(Number(result));
    const member = parseRoomMember(result);
    if (!member) throw new AppRoomError("ROOM_REQUEST_FAILED", "invalid room member");
    const sequence = await this.announce({ roomId: seat.roomId, type: "realtime.room.presence.updated", payload: { roomId: seat.roomId, member } });
    return { member, sequence };
  }

  async publish(seat: AppRoomSeat, input: { event: string; data: unknown; clientEventId?: string; record: boolean }) {
    if (!REALTIME_ROOM_EVENT_NAME_PATTERN.test(input.event)) {
      throw new AppRoomError("INVALID_EVENT", `invalid room event name: ${input.event.slice(0, 64)}`);
    }
    if (input.event.toLowerCase().startsWith("cohub.")) {
      throw new AppRoomError("RESERVED_EVENT", "reserved room event name");
    }
    const data = encodeJson(input.data, REALTIME_ROOM_MAX_PAYLOAD_BYTES, () =>
      new AppRoomError("PAYLOAD_TOO_LARGE", "room event payload is too large"));
    const eventId = randomUUID();
    const sequence = Number(await this.redis.eval(
      PUBLISH,
      7,
      ...this.seatKeys(seat.roomId),
      getRealtimeRoomSequenceKey(seat.roomId),
      getRealtimeRoomRateKey(seat.roomId),
      getRealtimeRoomHistoryKey(seat.roomId),
      getRealtimeRoomHistoryMetaKey(seat.roomId),
      seat.participantId,
      seat.owner,
      eventId,
      input.event,
      data,
      seat.roomId,
      getRealtimeRoom(seat.roomId),
      String(APP_ROOM_MAX_EVENT_RATE),
      input.clientEventId ?? "",
      REALTIME_OUTBOUND_CHANNEL,
      input.record ? "1" : "0",
      String(REALTIME_ROOM_HISTORY_SIZE),
      String(REALTIME_ROOM_HISTORY_BYTES),
    ));
    if (sequence < 0) throw seatError(sequence);
    return { eventId, sequence, clientEventId: input.clientEventId ?? null };
  }

  async history(roomId: string, input: { after?: number; limit?: number } = {}): Promise<RealtimeRoomHistory> {
    const limit = Math.min(Math.max(1, Math.floor(input.limit ?? REALTIME_ROOM_HISTORY_PAGE)), REALTIME_ROOM_HISTORY_PAGE);
    const after = input.after === undefined ? -1 : Math.max(0, Math.floor(input.after));
    const [entries, truncated, latest] = await this.redis.eval(
      READ_HISTORY,
      3,
      getRealtimeRoomHistoryKey(roomId),
      getRealtimeRoomSequenceKey(roomId),
      getRealtimeRoomHistoryMetaKey(roomId),
      String(after),
      String(limit),
    ) as [StreamEntry[], number, number];
    const events = entries.flatMap((entry) => {
      const event = toHistoryEvent(entry);
      return event ? [event] : [];
    });
    const last = events.at(-1)?.sequence;
    const cursor = events.length === limit && last !== undefined ? last : Math.max(after, Number(latest) || 0);
    return { events, cursor, truncated: Number(truncated) === 1 };
  }

  async announce(input: { roomId: string; type: string; payload: Record<string, unknown> }) {
    const envelope: RealtimeEnvelope = {
      id: randomUUID(),
      timestamp: Date.now(),
      domain: "room",
      type: input.type,
      rooms: [getRealtimeRoom(input.roomId)],
      payload: input.payload,
    };
    const sequence = Number(await this.redis.eval(
      ANNOUNCE,
      2,
      getRealtimeRoomSequenceKey(input.roomId),
      getRealtimeRoomMetaKey(input.roomId),
      JSON.stringify(envelope),
      REALTIME_OUTBOUND_CHANNEL,
    ));
    if (sequence < 0) throw seatError(sequence);
    return sequence;
  }

  async release(seat: AppRoomSeat) {
    const member = await this.leave(seat);
    if (member) {
      await this.announce({ roomId: seat.roomId, type: "realtime.room.member.left", payload: { roomId: seat.roomId, member } })
        .catch(() => undefined);
    }
    return member;
  }

  async sweep(roomId: string) {
    const result = await this.redis.eval(SWEEP, 2, getRealtimeRoomMembersKey(roomId), getRealtimeRoomLeasesKey(roomId));
    const removed = Array.isArray(result) ? result.filter((value): value is string => typeof value === "string") : [];
    await this.announceLeft(roomId, removed);
    return removed;
  }

  private async announceLeft(roomId: string, participantIds: readonly string[]) {
    for (const participantId of participantIds) {
      await this.announce({ roomId, type: "realtime.room.member.left", payload: { roomId, member: { participantId } } })
        .catch(() => undefined);
    }
  }

  private seatKeys(roomId: string) {
    return [getRealtimeRoomMetaKey(roomId), getRealtimeRoomMembersKey(roomId), getRealtimeRoomLeasesKey(roomId)] as const;
  }
}

const presenceTooLarge = () => new AppRoomError("PAYLOAD_TOO_LARGE", "room presence is too large");
