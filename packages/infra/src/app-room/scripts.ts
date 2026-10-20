
const NOW = `local time = redis.call("time")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)`;

export const PUBLIC_MEMBER_LUA = `local function public(member)
  member.connectionId = nil
  member.rtcSessionId = nil
  member.instanceId = nil
  member.leaseSeconds = nil
  if not member.kind then member.kind = "user" end
  return member
end`;

const LIVE_ROOM = `local metaRaw = redis.call("get", KEYS[1])
if not metaRaw then return -1 end
local meta = cjson.decode(metaRaw)
${NOW}
if tonumber(meta.expiresAtMs) <= now then return -2 end`;

const OWNED_SEAT = `local raw = redis.call("hget", KEYS[2], ARGV[1])
local lease = redis.call("zscore", KEYS[3], ARGV[1])
if not raw or not lease or tonumber(lease) <= now then return -3 end
local member = cjson.decode(raw)
if member.connectionId ~= ARGV[2] then return -5 end`;

const RENEW_LEASE = (fallbackArg: string) => `local leaseSeconds = tonumber(member.leaseSeconds or ${fallbackArg})
redis.call("zadd", KEYS[3], math.min(now + leaseSeconds * 1000, tonumber(meta.expiresAtMs)), ARGV[1])`;

export const CLAIM_SEAT = `${PUBLIC_MEMBER_LUA}
local metaRaw = redis.call("get", KEYS[1])
if not metaRaw then return {-1} end
local meta = cjson.decode(metaRaw)
${NOW}
if tonumber(meta.expiresAtMs) <= now then return {-2} end
local swept = {}
for _, expiredId in ipairs(redis.call("zrangebyscore", KEYS[3], "-inf", now)) do
  redis.call("zrem", KEYS[3], expiredId)
  redis.call("hdel", KEYS[2], expiredId)
  table.insert(swept, expiredId)
end
local participantId = ARGV[1]
local kind = ARGV[7]
if meta.seatPerUser and kind == "user" then
  for _, existingId in ipairs(redis.call("zrange", KEYS[3], 0, -1)) do
    local existingRaw = redis.call("hget", KEYS[2], existingId)
    if existingRaw then
      local existing = cjson.decode(existingRaw)
      if existing.userKey == ARGV[5] and (existing.kind or "user") == "user" then
        participantId = existingId
        break
      end
    end
  end
end
local current = redis.call("hget", KEYS[2], participantId)
if not current and redis.call("zcard", KEYS[3]) >= tonumber(meta.maxParticipants) then return {-3} end
local member
local isNew = 0
local droppedPublications = 0
if current then
  member = cjson.decode(current)
  if ARGV[6] == "" or member.instanceId ~= ARGV[6] then
    if member.publications then droppedPublications = 1 end
    member.rtcSessionId = nil
    member.publications = nil
  end
else
  isNew = 1
  member = { participantId = participantId, joinedAt = ARGV[4], presence = cjson.null }
end
member.userKey = ARGV[5]
member.kind = kind
if ARGV[8] == "" then member.model = nil else member.model = cjson.decode(ARGV[8]) end
member.connectionId = ARGV[2]
if ARGV[6] == "" then member.instanceId = nil else member.instanceId = ARGV[6] end
if ARGV[9] == "1" then member.leaseSeconds = tonumber(ARGV[3]) else member.leaseSeconds = nil end
if ARGV[10] ~= "" then member.presence = cjson.decode(ARGV[10]) end
redis.call("hset", KEYS[2], participantId, cjson.encode(member))
redis.call("zadd", KEYS[3], math.min(now + tonumber(ARGV[3]) * 1000, tonumber(meta.expiresAtMs)), participantId)
redis.call("pexpireat", KEYS[2], math.floor(tonumber(meta.expiresAtMs)))
redis.call("pexpireat", KEYS[3], math.floor(tonumber(meta.expiresAtMs)))
return {1, isNew, cjson.encode(public(member)), droppedPublications, swept}
`;

export const SNAPSHOT = `${PUBLIC_MEMBER_LUA}
${NOW}
local members = {}
for _, participantId in ipairs(redis.call("zrangebyscore", KEYS[2], now, "+inf")) do
  local raw = redis.call("hget", KEYS[1], participantId)
  if raw then table.insert(members, public(cjson.decode(raw))) end
end
return {cjson.encode(members), tonumber(redis.call("get", KEYS[3])) or 0}
`;

export const LEAVE = `${PUBLIC_MEMBER_LUA}
local raw = redis.call("hget", KEYS[1], ARGV[1])
if not raw then return 0 end
local member = cjson.decode(raw)
if member.connectionId ~= ARGV[2] then return -1 end
redis.call("hdel", KEYS[1], ARGV[1])
redis.call("zrem", KEYS[2], ARGV[1])
return cjson.encode(public(member))
`;

export const RENEW = `${LIVE_ROOM}
${OWNED_SEAT}
${RENEW_LEASE("ARGV[3]")}
return 1
`;

export const SET_PRESENCE = `${PUBLIC_MEMBER_LUA}
${LIVE_ROOM}
${OWNED_SEAT}
member.presence = cjson.decode(ARGV[4])
redis.call("hset", KEYS[2], ARGV[1], cjson.encode(member))
${RENEW_LEASE("ARGV[3]")}
return cjson.encode(public(member))
`;

// Keeps the sender's JSON text as is: re-encoding it in Lua would turn `[]` into `{}`.
export const PUBLISH = `${LIVE_ROOM}
${OWNED_SEAT}
local second = tostring(math.floor(now / 1000))
if redis.call("hget", KEYS[5], "second") ~= second then
  redis.call("del", KEYS[5])
  redis.call("hset", KEYS[5], "second", second)
end
local count = redis.call("hincrby", KEYS[5], "count", 1)
redis.call("expire", KEYS[5], 2)
if count > tonumber(ARGV[8]) then return -4 end
if member.leaseSeconds then
  redis.call("zadd", KEYS[3], math.min(now + tonumber(member.leaseSeconds) * 1000, tonumber(meta.expiresAtMs)), ARGV[1])
end
local sequence = redis.call("incr", KEYS[4])
local expiresAt = math.floor(tonumber(meta.expiresAtMs))
redis.call("pexpireat", KEYS[4], expiresAt)
local clientEventId = cjson.null
if ARGV[9] ~= "" then clientEventId = ARGV[9] end
if ARGV[11] == "1" then
  local entry = cjson.encode({ id = ARGV[3], timestamp = now, type = ARGV[4], clientEventId = clientEventId, sender = ARGV[1] })
  local size = string.len(entry) + string.len(ARGV[5])
  if redis.call("exists", KEYS[6]) == 0 then redis.call("hset", KEYS[7], "bytes", 0) end
  redis.call("xadd", KEYS[6], sequence .. "-0", "m", entry, "d", ARGV[5], "z", size)
  local bytes = redis.call("hincrby", KEYS[7], "bytes", size)
  local length = redis.call("xlen", KEYS[6])
  while length > tonumber(ARGV[12]) or bytes > tonumber(ARGV[13]) do
    local oldest = redis.call("xrange", KEYS[6], "-", "+", "COUNT", 1)[1]
    if not oldest then break end
    redis.call("xdel", KEYS[6], oldest[1])
    local fields = oldest[2]
    for index = 1, #fields, 2 do
      if fields[index] == "z" then bytes = redis.call("hincrby", KEYS[7], "bytes", -tonumber(fields[index + 1])) end
    end
    redis.call("hset", KEYS[7], "floor", string.match(oldest[1], "^(%d+)"))
    length = length - 1
  end
  redis.call("pexpireat", KEYS[6], expiresAt)
  redis.call("pexpireat", KEYS[7], expiresAt)
end
local marker = ARGV[3] .. ":data"
local envelope = cjson.encode({
  id = ARGV[3],
  timestamp = now,
  domain = "room",
  type = "realtime.room.event",
  rooms = { ARGV[7] },
  payload = {
    roomId = ARGV[6],
    sequence = sequence,
    event = ARGV[4],
    data = marker,
    clientEventId = clientEventId,
    sender = { participantId = ARGV[1] }
  }
})
local first, last = string.find(envelope, cjson.encode(marker), 1, true)
redis.call("publish", ARGV[10], string.sub(envelope, 1, first - 1) .. ARGV[5] .. string.sub(envelope, last + 1))
return sequence
`;

export const READ_HISTORY = `local latest = tonumber(redis.call("get", KEYS[2])) or 0
local after = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if after < 0 then
  local newest = redis.call("xrevrange", KEYS[1], "+", "-", "COUNT", limit)
  local entries = {}
  for index = #newest, 1, -1 do table.insert(entries, newest[index]) end
  return {entries, 0, latest}
end
local entries = redis.call("xrange", KEYS[1], tostring(after + 1) .. "-0", "+", "COUNT", limit)
local floor = tonumber(redis.call("hget", KEYS[3], "floor")) or 0
local truncated = 0
if floor > after then truncated = 1 end
return {entries, truncated, latest}
`;

export const ANNOUNCE = `local metaRaw = redis.call("get", KEYS[2])
if not metaRaw then return -1 end
local meta = cjson.decode(metaRaw)
${NOW}
if tonumber(meta.expiresAtMs) <= now then return -2 end
local sequence = redis.call("incr", KEYS[1])
redis.call("pexpireat", KEYS[1], math.floor(tonumber(meta.expiresAtMs)))
local envelope = cjson.decode(ARGV[1])
envelope.timestamp = now
envelope.payload.sequence = sequence
redis.call("publish", ARGV[2], cjson.encode(envelope))
return sequence
`;

export const SWEEP = `${NOW}
local removed = {}
for _, participantId in ipairs(redis.call("zrangebyscore", KEYS[2], "-inf", now)) do
  if redis.call("zrem", KEYS[2], participantId) == 1 then
    redis.call("hdel", KEYS[1], participantId)
    table.insert(removed, participantId)
  end
end
return removed
`;
