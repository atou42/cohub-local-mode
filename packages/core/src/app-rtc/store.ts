import {
  getRealtimeRoom,
  getRealtimeRoomLeasesKey,
  getRealtimeRoomMembersKey,
  getRealtimeRoomMetaKey,
  getRealtimeRoomRtcRateKey,
  getRealtimeRoomRtcSessionKey,
  getRealtimeRoomSequenceKey,
  REALTIME_OUTBOUND_CHANNEL,
  REALTIME_ROOM_RTC_SESSIONS_KEY,
} from "@cohub/protocol/realtime";
import type { AppRtcPublication, AppRtcPublicationKind } from "@cohub/protocol/rtc";
import { PUBLIC_MEMBER_LUA } from "@cohub/infra/app-room";

export type AppRtcRedis = {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
};

export const APP_RTC_LIVENESS_INTERVAL_MS = 60_000;
export const APP_RTC_SWEEP_JOB = "app.rtc.sweep";
export const APP_RTC_SWEEP_SCHEDULER_ID = "app-rtc-sweep";
const SESSION_RETENTION_AFTER_ROOM_MS = 10 * 60_000;

const NOW = `local time = redis.call("time")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)`;

const MEMBER_PROLOGUE = `${NOW}
local metaRaw = redis.call("get", KEYS[1])
if not metaRaw then return {-1} end
local meta = cjson.decode(metaRaw)
if tonumber(meta.expiresAtMs) <= now then return {-2} end
local raw = redis.call("hget", KEYS[2], ARGV[1])
local lease = redis.call("zscore", KEYS[3], ARGV[1])
if not raw or not lease or tonumber(lease) <= now then return {-3} end
local member = cjson.decode(raw)`;

const MEMBER_RTC_SCRIPT = `${PUBLIC_MEMBER_LUA}
${MEMBER_PROLOGUE}
local mode = ARGV[3]
local before = member.publications
local previous = member.rtcSessionId or ""
local changed = false
if mode == "claim" then
  if member.userKey ~= ARGV[8] then return {-4} end
  member.rtcSessionId = ARGV[2]
  member.publications = nil
  changed = before ~= nil
else
  if member.rtcSessionId ~= ARGV[2] then return {-5} end
  if mode == "release" then
    member.rtcSessionId = nil
    member.publications = nil
    changed = before ~= nil
  else
    local list = {}
    if before then for _, item in ipairs(before) do table.insert(list, item) end end
    local payload = cjson.decode(ARGV[4])
    if mode == "add" then
      local limits = cjson.decode(ARGV[9])
      local names = {}
      local data, media = 0, 0
      for _, item in ipairs(list) do names[item.name] = true end
      for _, item in ipairs(payload) do
        if names[item.name] then return {-7} end
        names[item.name] = true
        table.insert(list, item)
      end
      for _, item in ipairs(list) do
        if item.kind == "data" then data = data + 1 else media = media + 1 end
      end
      if data > tonumber(limits.data) or media > tonumber(limits.media) then return {-6} end
      changed = #payload > 0
    else
      local remove = {}
      for _, id in ipairs(payload) do remove[id] = true end
      local kept = {}
      for _, item in ipairs(list) do
        if remove[item.id] then changed = true else table.insert(kept, item) end
      end
      list = kept
    end
    if #list == 0 then member.publications = nil else member.publications = list end
  end
end
redis.call("hset", KEYS[2], ARGV[1], cjson.encode(member))
local sequence = 0
if changed then
  sequence = redis.call("incr", KEYS[4])
  redis.call("pexpireat", KEYS[4], math.floor(tonumber(meta.expiresAtMs)))
  local envelope = {
    id = ARGV[5],
    timestamp = now,
    domain = "room",
    type = "realtime.room.publications.updated",
    rooms = { ARGV[6] },
    payload = { roomId = meta.id, sequence = sequence, member = public(member) }
  }
  redis.call("publish", ARGV[7], cjson.encode(envelope))
end
return {1, sequence, previous}
`;

const SEAT_SCRIPT = `${MEMBER_PROLOGUE}
if member.userKey ~= ARGV[3] then return {-4} end
return {1}
`;

const OWNER_SCRIPT = `${MEMBER_PROLOGUE}
if member.rtcSessionId ~= ARGV[2] then return {-5} end
return {1}
`;

const RESOLVE_SCRIPT = `${MEMBER_PROLOGUE}
if member.rtcSessionId ~= ARGV[2] then return {-5} end
local found = {}
for _, ref in ipairs(cjson.decode(ARGV[3])) do
  local publisherRaw = redis.call("hget", KEYS[2], ref[1])
  local publisherLease = redis.call("zscore", KEYS[3], ref[1])
  if ref[1] ~= ARGV[1] and publisherRaw and publisherLease and tonumber(publisherLease) > now then
    local publisher = cjson.decode(publisherRaw)
    if publisher.rtcSessionId and publisher.publications then
      for _, item in ipairs(publisher.publications) do
        if item.id == ref[2] then
          table.insert(found, { participantId = ref[1], sessionId = publisher.rtcSessionId, publication = item })
        end
      end
    end
  end
end
if #found == 0 then return {1, "[]"} end
return {1, cjson.encode(found)}
`;

const ACCUMULATE_USAGE = `local at = tonumber(redis.call("hget", KEYS[1], "use:at") or now)
for _, kind in ipairs({ "data", "audio", "video" }) do
  local active = tonumber(redis.call("hget", KEYS[1], "use:" .. kind .. ":n") or "0")
  if active > 0 and now > at then
    redis.call("hincrby", KEYS[1], "use:" .. kind .. ":ms", active * (now - at))
  end
end
redis.call("hset", KEYS[1], "use:at", now)`;

const SESSION_UPDATE_SCRIPT = `${NOW}
if redis.call("exists", KEYS[1]) == 0 then return -1 end
local change = cjson.decode(ARGV[1])
local deltas = change.subscriptions or {}
local function active(kind) return tonumber(redis.call("hget", KEYS[1], "use:" .. kind .. ":n") or "0") end
if change.limits then
  local data = active("data") + math.max(0, tonumber(deltas.data or 0))
  local media = active("audio") + active("video") + math.max(0, tonumber(deltas.audio or 0)) + math.max(0, tonumber(deltas.video or 0))
  if data > tonumber(change.limits.data) or media > tonumber(change.limits.media) then return -6 end
end
${ACCUMULATE_USAGE}
for _, item in ipairs(change.release or {}) do
  if redis.call("hdel", KEYS[1], item[1]) == 1 then
    deltas[item[2]] = (tonumber(deltas[item[2]]) or 0) - 1
  end
end
for kind, delta in pairs(deltas) do
  redis.call("hset", KEYS[1], "use:" .. kind .. ":n", math.max(0, active(kind) + tonumber(delta)))
end
for kind, count in pairs(change.publications or {}) do
  redis.call("hincrby", KEYS[1], "pub:" .. kind, tonumber(count))
end
for field, value in pairs(change.set or {}) do redis.call("hset", KEYS[1], field, value) end
for _, field in ipairs(change.del or {}) do redis.call("hdel", KEYS[1], field) end
return 1
`;

const SESSION_CREATE_SCRIPT = `${NOW}
for field, value in pairs(cjson.decode(ARGV[2])) do redis.call("hset", KEYS[1], field, value) end
redis.call("hset", KEYS[1], "use:at", now)
redis.call("pexpireat", KEYS[1], tonumber(ARGV[3]))
redis.call("zadd", KEYS[2], tonumber(ARGV[4]), ARGV[1])
return 1
`;

const SESSION_CLOSE_SCRIPT = `${NOW}
redis.call("zrem", KEYS[2], ARGV[1])
if redis.call("exists", KEYS[1]) == 0 then return {} end
${ACCUMULATE_USAGE}
local record = redis.call("hgetall", KEYS[1])
redis.call("del", KEYS[1])
return record
`;

const SWEEP_CLAIM_SCRIPT = `${NOW}
local due = redis.call("zrangebyscore", KEYS[1], "-inf", now, "LIMIT", 0, tonumber(ARGV[1]))
for _, id in ipairs(due) do redis.call("zadd", KEYS[1], now + tonumber(ARGV[2]), id) end
return due
`;

const RATE_SCRIPT = `
local count = redis.call("incr", KEYS[1])
if count == 1 then redis.call("pexpire", KEYS[1], 2000) end
if count > tonumber(ARGV[1]) then return 0 end
return 1
`;

export type MemberRtcStatus = "room_not_found" | "room_expired" | "not_member" | "forbidden" | "stale" | "limit" | "name_taken";

const MEMBER_STATUS: Record<number, MemberRtcStatus> = {
  [-1]: "room_not_found",
  [-2]: "room_expired",
  [-3]: "not_member",
  [-4]: "forbidden",
  [-5]: "stale",
  [-6]: "limit",
  [-7]: "name_taken",
};

export class MemberRtcError extends Error {
  constructor(readonly status: MemberRtcStatus) {
    super(`room member rtc: ${status}`);
    this.name = "MemberRtcError";
  }
}

const memberKeys = (roomId: string) => [
  getRealtimeRoomMetaKey(roomId),
  getRealtimeRoomMembersKey(roomId),
  getRealtimeRoomLeasesKey(roomId),
] as const;

const asReply = (value: unknown) => (Array.isArray(value) ? value : [value]) as [number, ...unknown[]];

const checkMemberReply = (reply: unknown) => {
  const result = asReply(reply);
  const code = Number(result[0]);
  if (code !== 1) throw new MemberRtcError(MEMBER_STATUS[code] ?? "stale");
  return result;
};

export type MemberRtcChange =
  | { mode: "claim"; userKey: string }
  | { mode: "add"; publications: AppRtcPublication[]; limits: { data: number; media: number } }
  | { mode: "remove"; ids: string[] }
  | { mode: "release" };

export type SessionRecord = {
  appId: string;
  roomId: string;
  participantId: string;
  userUuid: string;
  spaceId: string;
  openedAt: number;
  local: Map<string, LocalResource>;
  remote: Map<string, RemoteResource>;
  usage: {
    publications: Record<AppRtcPublicationKind, number>;
    subscriptionMs: Record<AppRtcPublicationKind, number>;
  };
};

export type LocalResource = { kind: AppRtcPublicationKind; name: string; channelId?: number; mid?: string };
export type RemoteResource = { kind: AppRtcPublicationKind; channelId?: number; mid?: string };

export type ResolvedPublication = { participantId: string; sessionId: string; publication: AppRtcPublication };

export type SessionChange = {
  set?: Record<string, string>;
  del?: string[];
  subscriptions?: Partial<Record<AppRtcPublicationKind, number>>;
  release?: Array<[string, AppRtcPublicationKind]>;
  publications?: Partial<Record<AppRtcPublicationKind, number>>;
  limits?: { data: number; media: number };
};

export const localField = (publicationId: string) => `local:${publicationId}`;
export const remoteField = (participantId: string, publicationId: string) => `remote:${participantId}:${publicationId}`;

const KINDS: AppRtcPublicationKind[] = ["data", "audio", "video"];

function parseSessionRecord(hash: Record<string, string>): SessionRecord | null {
  if (!hash.appId || !hash.roomId || !hash.participantId || !hash.userUuid) return null;
  const record: SessionRecord = {
    appId: hash.appId,
    roomId: hash.roomId,
    participantId: hash.participantId,
    userUuid: hash.userUuid,
    spaceId: hash.spaceId ?? "",
    openedAt: Number(hash.openedAt) || 0,
    local: new Map(),
    remote: new Map(),
    usage: {
      publications: { data: 0, audio: 0, video: 0 },
      subscriptionMs: { data: 0, audio: 0, video: 0 },
    },
  };
  for (const kind of KINDS) {
    record.usage.publications[kind] = Number(hash[`pub:${kind}`]) || 0;
    record.usage.subscriptionMs[kind] = Number(hash[`use:${kind}:ms`]) || 0;
  }
  for (const [field, value] of Object.entries(hash)) {
    try {
      if (field.startsWith("local:")) record.local.set(field.slice(6), JSON.parse(value) as LocalResource);
      else if (field.startsWith("remote:")) record.remote.set(field.slice(7), JSON.parse(value) as RemoteResource);
    } catch {
    }
  }
  return record;
}

export class AppRtcStore {
  constructor(private readonly redis: AppRtcRedis) {}

  async changeMember(input: {
    roomId: string;
    participantId: string;
    sessionId: string;
    change: MemberRtcChange;
    eventId: string;
  }): Promise<{ sequence: number; previousSessionId: string | null }> {
    const { change } = input;
    const payload = change.mode === "add" ? change.publications : change.mode === "remove" ? change.ids : [];
    const result = checkMemberReply(await this.redis.eval(
      MEMBER_RTC_SCRIPT,
      4,
      ...memberKeys(input.roomId),
      getRealtimeRoomSequenceKey(input.roomId),
      input.participantId,
      input.sessionId,
      change.mode,
      JSON.stringify(payload),
      input.eventId,
      getRealtimeRoom(input.roomId),
      REALTIME_OUTBOUND_CHANNEL,
      change.mode === "claim" ? change.userKey : "",
      change.mode === "add" ? JSON.stringify(change.limits) : "{}",
    ));
    const previous = typeof result[2] === "string" && result[2] ? result[2] : null;
    return { sequence: Number(result[1]) || 0, previousSessionId: previous === input.sessionId ? null : previous };
  }

  async assertSeat(roomId: string, participantId: string, userKey: string) {
    checkMemberReply(await this.redis.eval(SEAT_SCRIPT, 3, ...memberKeys(roomId), participantId, "", userKey));
  }

  async assertOwner(roomId: string, participantId: string, sessionId: string) {
    checkMemberReply(await this.redis.eval(OWNER_SCRIPT, 3, ...memberKeys(roomId), participantId, sessionId));
  }

  async ownerStatus(roomId: string, participantId: string, sessionId: string): Promise<"active" | MemberRtcStatus> {
    try {
      await this.assertOwner(roomId, participantId, sessionId);
      return "active";
    } catch (error) {
      if (error instanceof MemberRtcError) return error.status;
      throw error;
    }
  }

  async resolve(input: {
    roomId: string;
    participantId: string;
    sessionId: string;
    refs: Array<{ participantId: string; publicationId: string }>;
  }): Promise<ResolvedPublication[]> {
    const result = checkMemberReply(await this.redis.eval(
      RESOLVE_SCRIPT,
      3,
      ...memberKeys(input.roomId),
      input.participantId,
      input.sessionId,
      JSON.stringify(input.refs.map((ref) => [ref.participantId, ref.publicationId])),
    ));
    return JSON.parse(String(result[1] ?? "[]")) as ResolvedPublication[];
  }

  async createSession(input: {
    sessionId: string;
    appId: string;
    roomId: string;
    participantId: string;
    userUuid: string;
    spaceId: string;
    roomExpiresAtMs: number;
  }) {
    const fields = {
      appId: input.appId,
      roomId: input.roomId,
      participantId: input.participantId,
      userUuid: input.userUuid,
      spaceId: input.spaceId,
      openedAt: String(Date.now()),
    };
    await this.redis.eval(
      SESSION_CREATE_SCRIPT,
      2,
      getRealtimeRoomRtcSessionKey(input.sessionId),
      REALTIME_ROOM_RTC_SESSIONS_KEY,
      input.sessionId,
      JSON.stringify(fields),
      String(input.roomExpiresAtMs + SESSION_RETENTION_AFTER_ROOM_MS),
      String(Date.now() + APP_RTC_LIVENESS_INTERVAL_MS),
    );
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return parseSessionRecord(await this.redis.hgetall(getRealtimeRoomRtcSessionKey(sessionId)));
  }

  async updateSession(sessionId: string, change: SessionChange): Promise<"ok" | "missing" | "limit"> {
    const result = Number(await this.redis.eval(
      SESSION_UPDATE_SCRIPT,
      1,
      getRealtimeRoomRtcSessionKey(sessionId),
      JSON.stringify(change),
    ));
    return result === 1 ? "ok" : result === -6 ? "limit" : "missing";
  }

  async takeSession(sessionId: string): Promise<SessionRecord | null> {
    const flat = await this.redis.eval(
      SESSION_CLOSE_SCRIPT,
      2,
      getRealtimeRoomRtcSessionKey(sessionId),
      REALTIME_ROOM_RTC_SESSIONS_KEY,
      sessionId,
    );
    if (!Array.isArray(flat) || flat.length === 0) return null;
    const hash: Record<string, string> = {};
    for (let index = 0; index + 1 < flat.length; index += 2) hash[String(flat[index])] = String(flat[index + 1]);
    return parseSessionRecord(hash);
  }

  async claimDueSessions(limit: number): Promise<string[]> {
    const due = await this.redis.eval(
      SWEEP_CLAIM_SCRIPT,
      1,
      REALTIME_ROOM_RTC_SESSIONS_KEY,
      String(limit),
      String(APP_RTC_LIVENESS_INTERVAL_MS),
    );
    return Array.isArray(due) ? due.map(String) : [];
  }

  async consumeRate(scope: string, limit: number): Promise<boolean> {
    const second = Math.floor(Date.now() / 1000);
    return Number(await this.redis.eval(RATE_SCRIPT, 1, getRealtimeRoomRtcRateKey(`${scope}:${second}`), String(limit))) === 1;
  }
}

