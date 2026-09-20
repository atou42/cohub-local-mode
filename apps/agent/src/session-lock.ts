import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { redis } from "./redis.js";
import { env } from "./env.js";
import { monitorSessionLease } from "./session-lease.js";
import { createLogger } from "@cohub/infra/logging";


const logger = createLogger({ serviceName: "cohub-agent" });
const lockKey = (sessionId: string) => `agent:session:${sessionId}:lock`;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

export type SessionLock = {
  sessionId: string;
  token: string;
  signal: AbortSignal;
  stop: () => void;
  release: () => Promise<void>;
};

export async function acquireSessionLock(sessionId: string): Promise<SessionLock | null> {
  const token = `${process.env.HOSTNAME ?? process.pid}:${randomUUID()}`;
  const key = lockKey(sessionId);
  const acquiredAt = performance.now();
  const acquired = await redis.set(key, token, "PX", env.AGENT_SESSION_LOCK_TTL_MS, "NX");
  if (acquired !== "OK") return null;

  const lease = monitorSessionLease({
    acquiredAt,
    ttlMs: env.AGENT_SESSION_LOCK_TTL_MS,
    intervalMs: env.AGENT_SESSION_LOCK_RENEW_INTERVAL_MS,
    renew: () => redis.eval(RENEW_SCRIPT, 1, key, token, String(env.AGENT_SESSION_LOCK_TTL_MS)),
    onError: (error) => logger.warn(`[AgentLock] renew failed sessionId=${sessionId}:`, error),
  });

  return {
    sessionId,
    token,
    signal: lease.signal,
    stop: lease.stop,
    release: async () => {
      lease.stop();
      await redis.eval(RELEASE_SCRIPT, 1, key, token).catch((error) => {
        logger.warn(`[AgentLock] release failed sessionId=${sessionId}:`, error);
      });
    },
  };
}
