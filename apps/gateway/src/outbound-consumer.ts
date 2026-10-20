import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { PlannedGatewayOutboundCommand } from "@cohub/protocol/gateway";
import { createLogger } from "@cohub/infra/logging";
import { createBlockingRedisClient, getGatewayNodeOutboundStreamKey, redisCommandClient as redis, type RedisStreamEntry } from "./redis.js";
import { createOutboundCheckpoint } from "./outbound-progress.js";
import { OutboundDeliveryUnknownError, type GatewayOutboundContext, type GatewayOutboundResult } from "./providers/base.js";
import { OutboundScheduler } from "./outbound-scheduler.js";
import { gatewayConfig } from "./config.js";
import { extractMediaLinks, isVideoUrl } from "./media-links.js";

const logger = createLogger({ serviceName: "cohub-gateway" });
const GROUP = "gateway-outbound-consumers";
const LEASE_MS = 60_000;
const DONE_TTL = 86_400;
export const OUTBOUND_FAILURE_STREAM = "stream:gateway:outbound:failed";
export const getOutboundStreamForNode = getGatewayNodeOutboundStreamKey;
type Handler = (cmd: PlannedGatewayOutboundCommand, context: GatewayOutboundContext) => Promise<GatewayOutboundResult>;

export const conversationKey = (cmd: PlannedGatewayOutboundCommand) => JSON.stringify([cmd.channelId, cmd.externalChatId]);
export function parseOutboundCommand(fields: string[]): PlannedGatewayOutboundCommand {
  const index = fields.indexOf("payload");
  const payload = index < 0 ? undefined : fields[index + 1];
  if (!payload) throw new Error("Missing outbound payload");
  const cmd = JSON.parse(payload) as PlannedGatewayOutboundCommand;
  if (!cmd || ![cmd.commandId, cmd.channelId, cmd.externalChatId, cmd.provider].every((value) => typeof value === "string" && value.length > 0)
    || !Array.isArray(cmd.content) || !Number.isFinite(cmd.timestamp)) throw new Error("Invalid outbound command");
  for (const block of cmd.content) {
    if (!block || typeof block.type !== "string") throw new Error("Invalid outbound content block");
    if ((block.type === "text" || block.type === "system_note") && typeof block.text !== "string") throw new Error("Invalid outbound text");
    if (block.type === "image" && (!block.source || !(
      (block.source.type === "url" && typeof block.source.url === "string") ||
      (block.source.type === "base64" && typeof block.source.data === "string" && typeof block.source.media_type === "string")
    ))) throw new Error("Invalid outbound image");
  }
  return cmd;
}

export function hasOutboundMedia(cmd: PlannedGatewayOutboundCommand) {
  return cmd.content.some((block) => block.type === "image" && !(cmd.provider === "wechat" && block.source.type === "url" && isVideoUrl(block.source.url)))
    || extractMediaLinks(cmd.content, { maxItems: 100 }).some((item) => cmd.provider !== "wechat" || (item.kind !== "video" && !(item.source.type === "url" && isVideoUrl(item.source.url))));
}

export const initOutboundConsumerGroup = async (nodeId: string) => {
  try {
    await redis.xgroup("CREATE", getOutboundStreamForNode(nodeId), GROUP, "0", "MKSTREAM");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("BUSYGROUP")) throw error;
  }
};

const ack = async (stream: string, id: string) => {
  await redis.eval("redis.call('XACK', KEYS[1], ARGV[1], ARGV[2]); return redis.call('XDEL', KEYS[1], ARGV[2])", 1, stream, GROUP, id);
};

const archive = async (stream: string, id: string, fields: string[], error: string, commandId?: string, route?: { nodeId: string; channelId: string; unbound?: boolean }) => {
  const archived = await redis.eval(`
    if ARGV[8] ~= '' then
      local owner = redis.call('HGET', KEYS[4], ARGV[9])
      if owner and (ARGV[10] == '1' or owner ~= ARGV[8]) then return 0 end
    end
    redis.call('XADD', KEYS[2], '*', 'sourceStream', KEYS[1], 'streamId', ARGV[2], 'fields', ARGV[3], 'error', ARGV[4], 'failedAt', ARGV[5])
    if ARGV[6] ~= '' then redis.call('SET', KEYS[3], 'failed', 'EX', ARGV[7]) end
    redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
    redis.call('XDEL', KEYS[1], ARGV[2])
    return 1
  `, 4, stream, OUTBOUND_FAILURE_STREAM, `gateway:outbound:done:${commandId ?? "invalid"}`, "gateway:channel_routing", GROUP, id, JSON.stringify(fields), error, Date.now(), commandId ?? "", DONE_TTL, route?.nodeId ?? "", route?.channelId ?? "", route?.unbound ? "1" : "0");
  if (archived !== 1) return false;
  logger.error("[Bus] Archived failed outbound command", { streamId: id, commandId, error });
  return true;
};

const rerouteIfMoved = async (nodeId: string, stream: string, id: string, cmd: PlannedGatewayOutboundCommand) => {
  while (true) {
    const owner = await redis.hget("gateway:channel_routing", cmd.channelId);
    if (!owner || owner === nodeId) return false;
    const moved = await redis.eval(`
      if redis.call('HGET', KEYS[2], ARGV[4]) ~= ARGV[1] then return 0 end
      if #redis.call('XRANGE', KEYS[1], ARGV[3], ARGV[3], 'COUNT', 1) > 0 then
        redis.call('XADD', KEYS[3], '*', 'payload', ARGV[5])
      end
      redis.call('XACK', KEYS[1], ARGV[2], ARGV[3])
      redis.call('XDEL', KEYS[1], ARGV[3])
      return 1
    `, 3, stream, "gateway:channel_routing", getOutboundStreamForNode(owner), owner, GROUP, id, cmd.channelId,
    JSON.stringify({ ...cmd, meta: { ...cmd.meta, targetNodeId: owner } }));
    if (moved === 1) return true;
  }
};

const processEntry = async (nodeId: string, stream: string, id: string, fields: string[], cmd: PlannedGatewayOutboundCommand, handler: Handler, stopping: AbortSignal) => {
  const token = randomUUID();
  const keys = [`gateway:outbound:lock:${cmd.commandId}`, `gateway:outbound:conversation:${createHash("sha256").update(conversationKey(cmd)).digest("hex")}`];
  const doneKey = `gateway:outbound:done:${cmd.commandId}`;
  const progressKey = `gateway:outbound:progress:${cmd.commandId}`;
  stopping.throwIfAborted();
  if (await rerouteIfMoved(nodeId, stream, id, cmd)) return;
  if (await redis.exists(doneKey)) { await ack(stream, id); return; }
  const acquired = await redis.eval(`
    if redis.call('EXISTS', KEYS[1], KEYS[2]) > 0 then return 0 end
    redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
    redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
    return 1
  `, 2, ...keys, token, LEASE_MS);
  if (acquired !== 1) return "deferred";
  const controller = new AbortController();
  const signal = AbortSignal.any([stopping, controller.signal]);
  let renewing = false;
  const watchdog = setTimeout(() => controller.abort(new Error("Outbound lease renewal timed out")), LEASE_MS - 10_000);
  watchdog.unref();
  const timer = setInterval(() => {
    if (renewing || signal.aborted) return;
    renewing = true;
    void redis.eval(`
      if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
      redis.call('PEXPIRE', KEYS[1], ARGV[2]); redis.call('PEXPIRE', KEYS[2], ARGV[2]); return 1
    `, 2, ...keys, token, LEASE_MS).then((result) => {
      if (result !== 1) controller.abort(new Error("Outbound lease lost"));
      else watchdog.refresh();
    }).catch((error) => controller.abort(error)).finally(() => { renewing = false; });
  }, LEASE_MS / 4);
  timer.unref();
  try {
    if (await redis.exists(doneKey)) { await ack(stream, id); return; }
    const context: GatewayOutboundContext = {
      signal,
      checkpoint: createOutboundCheckpoint({
        get: (itemId) => redis.hget(progressKey, `item:${itemId}`),
        set: (itemId, value) => redis.hset(progressKey, `item:${itemId}`, value),
        delete: (itemId) => redis.hdel(progressKey, `item:${itemId}`),
      }, signal),
    };
    const legacyAttempt = cmd.meta?.deliveryAttempt;
    let attempt = Number(await redis.hget(progressKey, "attempt")) || (typeof legacyAttempt === "number" ? legacyAttempt : 0);
    let result: GatewayOutboundResult = { success: false, error: "Outbound attempts exhausted" };
    while (attempt < 3) {
      signal.throwIfAborted();
      if (await rerouteIfMoved(nodeId, stream, id, cmd)) return;
      const startedAt = Date.now();
      logger.info("[Bus] Consuming outbound command", { streamId: id, commandId: cmd.commandId, channelId: cmd.channelId, provider: cmd.provider, externalChatId: cmd.externalChatId, attempt: attempt + 1, queueMs: startedAt - cmd.timestamp });
      try {
        result = await handler(cmd, context);
      } catch (error) {
        result = { success: false, error: error instanceof Error ? error.message : String(error), retryable: !(error instanceof OutboundDeliveryUnknownError) };
      }
      signal.throwIfAborted();
      if (!result.success && await rerouteIfMoved(nodeId, stream, id, cmd)) return;
      if (result.deferred) {
        const owner = await redis.hget("gateway:channel_routing", cmd.channelId);
        if (!owner && await archive(stream, id, fields, "Channel is unbound", cmd.commandId, { nodeId, channelId: cmd.channelId, unbound: true })) return;
        return "deferred";
      }
      attempt += 1;
      await redis.hset(progressKey, "attempt", attempt);
      logger.info("[Bus] Outbound attempt finished", { commandId: cmd.commandId, attempt, success: result.success, durationMs: Date.now() - startedAt, totalMs: Date.now() - cmd.timestamp });
      if (result.success || result.retryable === false) break;
      if (attempt < 3) await delay(500 * 2 ** (attempt - 1) + Math.random() * 250, undefined, { signal });
    }
    if (result.success) {
      await redis.eval(`
        redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])
        redis.call('EXPIRE', KEYS[3], ARGV[3])
        redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
        return redis.call('XDEL', KEYS[1], ARGV[2])
      `, 3, stream, doneKey, progressKey, GROUP, id, DONE_TTL);
    } else {
      if (await rerouteIfMoved(nodeId, stream, id, cmd)) return;
      if (!await archive(stream, id, fields, result.error ?? "Outbound failed", cmd.commandId, { nodeId, channelId: cmd.channelId })) {
        if (!await rerouteIfMoved(nodeId, stream, id, cmd)) throw new Error("Outbound route changed during archival");
      }
    }
  } finally {
    clearInterval(timer);
    clearTimeout(watchdog);
    await redis.eval(`
      for _, key in ipairs(KEYS) do if redis.call('GET', key) == ARGV[1] then redis.call('DEL', key) end end
      return 1
    `, 2, ...keys, token).catch((error) => logger.warn("[Bus] Failed to release outbound lease", { error }));
  }
};

export const listenOutboundCommands = async (nodeId: string, handler: Handler, signal?: AbortSignal) => {
  const stream = getOutboundStreamForNode(nodeId);
  const consumer = `gateway-${nodeId}`;
  const stopping = signal ?? new AbortController().signal;
  const scheduler = new OutboundScheduler(256, gatewayConfig.outboundConcurrency);
  const outstanding = new Set<string>();
  const client = createBlockingRedisClient();
  const executionController = new AbortController();
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    client.disconnect();
    drainTimer = setTimeout(() => executionController.abort(), 25_000);
    drainTimer.unref();
  };
  stopping.addEventListener("abort", stop, { once: true });
  let pendingId: string | null = "0";
  let nextPendingScan = 0;
  let deferredKeys = new Set<string>();
  let scanDeferredKeys = new Set<string>();
  const retryAfter = new Map<string, number>();
  const deferConversation = (key: string) => {
    retryAfter.set(key, Date.now() + 1000);
    deferredKeys.add(key);
    scanDeferredKeys.add(key);
    scheduler.releaseQueued(key);
  };
  let reclaimId = "0-0";
  let nextReclaim = 0;
  try {
    if (client.status === "wait") await client.connect();
    while (!stopping.aborted) {
      try {
        await scheduler.waitForCapacity();
        if (stopping.aborted) break;
        const count = Math.min(10, scheduler.capacity - scheduler.size);
        if (pendingId === null && deferredKeys.size > 0 && Date.now() >= nextPendingScan) pendingId = "0";
        const scanningPending = pendingId !== null;
        let messages: RedisStreamEntry[];
        if (pendingId !== null) {
          const rows = await client.xreadgroup("GROUP", GROUP, consumer, "COUNT", count, "STREAMS", stream, pendingId) as Array<[string, RedisStreamEntry[]]> | null;
          messages = rows?.[0]?.[1] ?? [];
          pendingId = messages.at(-1)?.[0] ?? null;
          if (pendingId === null) {
            deferredKeys = scanDeferredKeys;
            scanDeferredKeys = new Set();
            nextPendingScan = Number.POSITIVE_INFINITY;
            for (const key of retryAfter.keys()) if (!deferredKeys.has(key)) retryAfter.delete(key);
            for (const key of deferredKeys) {
              nextPendingScan = Math.min(nextPendingScan, retryAfter.get(key) ?? (scheduler.pendingFor(key) > 0 ? Number.POSITIVE_INFINITY : 0));
            }
          }
        } else if (Date.now() >= nextReclaim) {
          const claimed = await client.xautoclaim(stream, GROUP, consumer, LEASE_MS, reclaimId, "COUNT", count) as [string, RedisStreamEntry[]];
          reclaimId = claimed[0];
          messages = claimed[1];
          if (reclaimId === "0-0") nextReclaim = Date.now() + LEASE_MS / 2;
        } else {
          const rows = await client.xreadgroup("GROUP", GROUP, consumer, "COUNT", count, "BLOCK", deferredKeys.size ? 100 : 1000, "STREAMS", stream, ">") as Array<[string, RedisStreamEntry[]]> | null;
          messages = rows?.[0]?.[1] ?? [];
        }
        for (const [id, fields] of messages) {
          if (outstanding.has(id)) continue;
          let cmd: PlannedGatewayOutboundCommand;
          try { cmd = parseOutboundCommand(fields); }
          catch (error) { await archive(stream, id, fields, String(error)); continue; }
          const key = conversationKey(cmd);
          if ((retryAfter.get(key) ?? 0) > Date.now() || scheduler.pendingFor(key) >= 8 || (scanningPending ? scanDeferredKeys.has(key) : deferredKeys.has(key))) {
            deferredKeys.add(key);
            if (scanningPending) scanDeferredKeys.add(key);
            continue;
          }
          retryAfter.delete(key);
          outstanding.add(id);
          scheduler.add({
            key, provider: cmd.provider, media: hasOutboundMedia(cmd),
            onRelease: () => outstanding.delete(id),
            run: async () => {
              try {
                if (!stopping.aborted && await processEntry(nodeId, stream, id, fields, cmd, handler, executionController.signal) === "deferred") deferConversation(key);
              } catch (error) {
                if (!stopping.aborted) {
                  logger.error("[Bus] Outbound entry remains pending; retrying recovery", { streamId: id, commandId: cmd.commandId, error });
                  deferConversation(key);
                }
              } finally { outstanding.delete(id); nextPendingScan = 0; }
            },
          });
        }
      } catch (error) {
        if (stopping.aborted) break;
        logger.error("[Bus] Outbound read failed", { error });
        await delay(1000, undefined, { signal: stopping }).catch(() => undefined);
      }
    }
  } finally {
    stopping.removeEventListener("abort", stop);
    client.disconnect();
    await scheduler.drain();
    if (drainTimer) clearTimeout(drainTimer);
  }
};
