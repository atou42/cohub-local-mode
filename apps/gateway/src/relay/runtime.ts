import { createAgentTurnsQueue, enqueueRuntimeRecovery } from "@cohub/infra/agent-queue";
import { runtimeRegistrationKey } from "@cohub/protocol";
import { authorizeLocalSandbox } from "../api-client.js";
import { gatewayConfig } from "../config.js";
import { redisCommandClient } from "../redis.js";
import { createRuntimeRecoveryLifecycle, createRuntimeRelay } from "./runtime-relay.js";

const recoveryQueue = createAgentTurnsQueue(gatewayConfig.bullmqRedisUrl, "cohub-gateway-runtime");
const recovery = createRuntimeRecoveryLifecycle({
  enqueue: (spaceId, ownerUserId, execution) => enqueueRuntimeRecovery(recoveryQueue, {
    spaceId,
    sessionId: execution.sessionId,
    expectedTurnId: execution.turnId,
    expectedHarness: execution.harness,
    expectedOwnerUserId: ownerUserId,
  }),
  close: () => recoveryQueue.close(),
});
const relay = createRuntimeRelay({
  recover: recovery.recover,
  secret: gatewayConfig.workerSecret,
  endpoint: (spaceId, connectionId) => {
    const host = gatewayConfig.podIp.includes(":") ? `[${gatewayConfig.podIp}]` : gatewayConfig.podIp;
    return `ws://${host}:${gatewayConfig.port}/internal/runtime-relay/${spaceId}?connection=${connectionId}`;
  },
  authorize: (authToken, spaceId) => authorizeLocalSandbox({ authToken, spaceId }),
  claim: async (spaceId, record) => await redisCommandClient.set(runtimeRegistrationKey(spaceId), JSON.stringify(record), "EX", 40, "NX") === "OK",
  renew: async (spaceId, record) => await redisCommandClient.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], 40) else return 0 end", 1, runtimeRegistrationKey(spaceId), JSON.stringify(record)) === 1,
  release: async (spaceId, record) => {
    await redisCommandClient.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", 1, runtimeRegistrationKey(spaceId), JSON.stringify(record));
  },
});

export const handleRuntimeConnection = relay.control;
export const handleRuntimePeer = relay.peer;
export async function closeRuntimeRelay() {
  await recovery.close();
}
