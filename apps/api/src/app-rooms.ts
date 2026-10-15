import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Redis } from "ioredis";
import {
  getRealtimeRoomCodeKey,
  getRealtimeRoomIndexKey,
  getRealtimeRoomMetaKey,
  type RealtimeRoomDescriptor,
} from "@cohub/protocol/realtime";
import { config } from "./config.js";

export const APP_ROOM_DEFAULT_EXPIRES_IN_SECONDS = 2 * 60 * 60;
export const APP_ROOM_MAX_EXPIRES_IN_SECONDS = 24 * 60 * 60;
export const APP_ROOM_MIN_EXPIRES_IN_SECONDS = 60;
export const APP_ROOM_DEFAULT_MAX_PARTICIPANTS = 16;
export const APP_ROOM_MAX_PARTICIPANTS = 128;
export const APP_ROOM_MAX_ACTIVE_PER_APP = 512;
export const APP_ROOM_DEFAULT_INVITE_SECONDS = 10 * 60;

const ROOM_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,47}$/;
// KEYS: code, meta, per-app room index. The index is a sorted set scored by
// expiresAtMs so expired rooms are swept here instead of needing a separate GC.
// Meta uses PXAT so it survives until the exact logical expiry: truncating to
// whole seconds would drop it early and make a natural expiry look like a
// vanished room, which readers report as revoked rather than expired.
const CREATE_ROOM_SCRIPT = `
local time = redis.call("time")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call("zremrangebyscore", KEYS[3], "-inf", now)
if redis.call("zcard", KEYS[3]) >= tonumber(ARGV[4]) then return -1 end
if redis.call("exists", KEYS[1]) == 1 then return 0 end
redis.call("set", KEYS[1], ARGV[1], "PXAT", ARGV[3])
redis.call("set", KEYS[2], ARGV[2], "PXAT", ARGV[3])
redis.call("zadd", KEYS[3], ARGV[3], ARGV[1])
-- Keep the index alive until its longest-lived room expires.
local newest = redis.call("zrange", KEYS[3], -1, -1, "WITHSCORES")
redis.call("pexpireat", KEYS[3], math.floor(tonumber(newest[2])))
return 1
`;

export type AppRoomRecord = RealtimeRoomDescriptor & { appId: string; expiresAtMs: number };

export class AppRoomOptionsError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_CODE"
      | "INVALID_TTL"
      | "INVALID_CAPACITY"
      | "ROOM_CODE_TAKEN"
      | "ROOM_QUOTA_EXCEEDED",
  ) {
    super(message);
    this.name = "AppRoomOptionsError";
  }
}

export const appRoomOptionsErrorStatus = (error: AppRoomOptionsError) =>
  error.code === "ROOM_QUOTA_EXCEEDED" ? 429 : error.code === "ROOM_CODE_TAKEN" ? 409 : 400;

export const normalizeAppRoomCode = (value: unknown) => {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return ROOM_CODE_RE.test(code) ? code : null;
};

export const normalizeAppRoomOptions = (input: {
  code?: unknown;
  expiresInSeconds?: unknown;
  maxParticipants?: unknown;
  seatPerUser?: unknown;
}) => {
  const code = input.code === undefined ? null : normalizeAppRoomCode(input.code);
  if (input.code !== undefined && !code) {
    throw new AppRoomOptionsError("room code must be 3-48 ASCII characters", "INVALID_CODE");
  }

  const expiresInSeconds = input.expiresInSeconds === undefined
    ? APP_ROOM_DEFAULT_EXPIRES_IN_SECONDS
    : Number(input.expiresInSeconds);
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < APP_ROOM_MIN_EXPIRES_IN_SECONDS || expiresInSeconds > APP_ROOM_MAX_EXPIRES_IN_SECONDS) {
    throw new AppRoomOptionsError(
      `expiresInSeconds must be between ${APP_ROOM_MIN_EXPIRES_IN_SECONDS} and ${APP_ROOM_MAX_EXPIRES_IN_SECONDS}`,
      "INVALID_TTL",
    );
  }

  const maxParticipants = input.maxParticipants === undefined
    ? APP_ROOM_DEFAULT_MAX_PARTICIPANTS
    : Number(input.maxParticipants);
  if (!Number.isInteger(maxParticipants) || maxParticipants < 2 || maxParticipants > APP_ROOM_MAX_PARTICIPANTS) {
    throw new AppRoomOptionsError(`maxParticipants must be between 2 and ${APP_ROOM_MAX_PARTICIPANTS}`, "INVALID_CAPACITY");
  }

  if (input.seatPerUser !== undefined && typeof input.seatPerUser !== "boolean") {
    throw new AppRoomOptionsError("seatPerUser must be a boolean", "INVALID_CAPACITY");
  }

  return { code, expiresInSeconds, maxParticipants, seatPerUser: input.seatPerUser === true };
};

export const serializeAppRoom = (value: AppRoomRecord): RealtimeRoomDescriptor => ({
  id: value.id,
  code: value.code,
  createdAt: value.createdAt,
  expiresAt: value.expiresAt,
  maxParticipants: value.maxParticipants,
  seatPerUser: value.seatPerUser,
});

const readRoom = (raw: string | null): AppRoomRecord | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AppRoomRecord>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.appId !== "string" ||
      typeof parsed.expiresAtMs !== "number" ||
      typeof parsed.code !== "string" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.expiresAt !== "string" ||
      typeof parsed.maxParticipants !== "number"
    ) return null;
    return { ...parsed, seatPerUser: parsed.seatPerUser === true } as AppRoomRecord;
  } catch {
    return null;
  }
};

const resolveRedis = async (redis?: Redis) => redis ?? (await import("./redis.js")).redisCommandClient;

export async function getAppRoomById(roomId: string, redis?: Redis) {
  const client = await resolveRedis(redis);
  const room = readRoom(await client.get(getRealtimeRoomMetaKey(roomId)));
  if (!room || room.expiresAtMs <= Date.now()) return null;
  return room;
}

export async function getAppRoomByCode(appId: string, codeValue: unknown, redis?: Redis) {
  const code = normalizeAppRoomCode(codeValue);
  if (!code) return null;
  const client = await resolveRedis(redis);
  const roomId = await client.get(getRealtimeRoomCodeKey(appId, code));
  if (!roomId) return null;
  const room = await getAppRoomById(roomId, client);
  if (!room) {
    await client.del(getRealtimeRoomCodeKey(appId, code)).catch(() => undefined);
    return null;
  }
  return room;
}

const randomRoomCode = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(randomBytes(8), (value) => alphabet[value % alphabet.length]).join("");
};

export async function createAppRoom(input: {
  appId: string;
  code?: unknown;
  expiresInSeconds?: unknown;
  maxParticipants?: unknown;
  seatPerUser?: unknown;
  redis?: Redis;
}) {
  const options = normalizeAppRoomOptions(input);
  const redis = await resolveRedis(input.redis);
  const createdAtMs = Date.now();
  const expiresAtMs = createdAtMs + options.expiresInSeconds * 1000;
  const record: AppRoomRecord = {
    id: randomUUID(),
    appId: input.appId,
    expiresAtMs,
    code: options.code ?? randomRoomCode(),
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    maxParticipants: options.maxParticipants,
    seatPerUser: options.seatPerUser,
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt > 0 && options.code) {
      throw new AppRoomOptionsError("room code is already in use", "ROOM_CODE_TAKEN");
    }
    if (attempt > 0) record.code = randomRoomCode();
    const result = await redis.eval(
      CREATE_ROOM_SCRIPT,
      3,
      getRealtimeRoomCodeKey(input.appId, record.code),
      getRealtimeRoomMetaKey(record.id),
      getRealtimeRoomIndexKey(input.appId),
      record.id,
      JSON.stringify(record),
      String(expiresAtMs),
      String(APP_ROOM_MAX_ACTIVE_PER_APP),
    );
    const code = Number(result);
    if (code === -1) {
      throw new AppRoomOptionsError(`this app already has ${APP_ROOM_MAX_ACTIVE_PER_APP} active rooms`, "ROOM_QUOTA_EXCEEDED");
    }
    if (code === 1) return record;
  }
  throw new AppRoomOptionsError("unable to allocate a unique room code", "ROOM_CODE_TAKEN");
}


const secret = () => {
  if (!config.appEncryptionKey) throw new Error("Missing APP_ENCRYPTION_KEY for app room tokens");
  return config.appEncryptionKey;
};
const hmac = (value: string, key = secret()) => createHmac("sha256", key).update(value).digest();
const TOKEN_HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "COHUB_ROOM" })).toString("base64url");

type TokenBody = { typ: string; exp: number };

const signToken = <T extends TokenBody>(payload: T) => {
  const signingInput = `${TOKEN_HEADER}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${signingInput}.${hmac(signingInput).toString("base64url")}`;
};

const verifyToken = <T extends TokenBody>(token: string, ...types: T["typ"][]): T | null => {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];
  const expected = hmac(`${header}.${body}`);
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    if (!types.includes(payload.typ) || !Number.isInteger(payload.exp) || payload.exp * 1000 <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
};

export type AppRoomTicket = TokenBody & {
  typ: "app_room_ticket";
  appId: string;
  roomId: string;
  userUuid: string;
  participantId: string;
  userKey: string;
};

export type AppRoomInvite = TokenBody & { typ: "app_room_invite"; appId: string; roomId: string };
export type HostedRoomTicket = TokenBody & {
  typ: "hosted_room_ticket";
  appId: string;
  roomId: string;
  userUuid: string;
  participantId: string;
};

export const createHostedRoomTicket = (input: Omit<HostedRoomTicket, "typ" | "exp">, expiresAtMs: number) =>
  signToken({ typ: "hosted_room_ticket", ...input, exp: Math.floor(Math.min(expiresAtMs, Date.now() + 60_000) / 1000) } satisfies HostedRoomTicket);

export const verifyHostedRoomTicket = (token: string) => {
  const ticket = verifyToken<HostedRoomTicket>(token, "hosted_room_ticket");
  return ticket?.appId && ticket.roomId && ticket.userUuid && ticket.participantId ? ticket : null;
};

export const verifyAppRoomTicket = (token: string) => {
  // Tickets minted as `work_room_ticket` stay valid until their room expires, 24 hours at most.
  const ticket = verifyToken<AppRoomTicket>(token, "app_room_ticket", "work_room_ticket" as AppRoomTicket["typ"]);
  return ticket?.appId && ticket.roomId && ticket.userUuid && ticket.participantId && ticket.userKey ? ticket : null;
};

export const verifyAppRoomInvite = (token: string) => {
  const invite = verifyToken<AppRoomInvite>(token.trim(), "app_room_invite");
  return invite?.appId && invite.roomId ? invite : null;
};

export function createAppRoomInvite(room: AppRoomRecord, expiresInSeconds = APP_ROOM_DEFAULT_INVITE_SECONDS) {
  const expiresAtMs = Math.min(Date.now() + expiresInSeconds * 1000, room.expiresAtMs);
  return {
    invite: signToken({ typ: "app_room_invite", appId: room.appId, roomId: room.id, exp: Math.floor(expiresAtMs / 1000) } satisfies AppRoomInvite),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

/**
 * Opaque, stable identity for a person inside one room. Their tabs, CLI and Agents
 * share it, which lets a room enforce one seat per viewer and lets an App group
 * everyone acting for one person, without exposing the account id to peers.
 * `key` is injectable for tests; production always uses the configured key.
 */
export const deriveAppRoomUserKey = (roomId: string, userUuid: string, key: string = secret()) =>
  hmac(`participant:${roomId}:${userUuid}`, key).toString("hex").slice(0, 32);

export const deriveHostedSeatId = (roomId: string, userUuid: string, subject: string) => {
  const hex = hmac(`seat:${roomId}:${userUuid}:${subject}`).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export const createAppRoomAdmission = (input: { userUuid: string; room: AppRoomRecord }) => {
  // Per connection by default: two tabs are two participants. A room created with
  // seatPerUser collapses them at join time using the userKey below.
  const participantId = randomUUID();
  const userKey = deriveAppRoomUserKey(input.room.id, input.userUuid);
  return {
    room: serializeAppRoom(input.room),
    participantId,
    userKey,
    ticket: signToken({
      typ: "app_room_ticket",
      appId: input.room.appId,
      roomId: input.room.id,
      userUuid: input.userUuid,
      participantId,
      userKey,
      exp: Math.floor(input.room.expiresAtMs / 1000),
    } satisfies AppRoomTicket),
  };
};
