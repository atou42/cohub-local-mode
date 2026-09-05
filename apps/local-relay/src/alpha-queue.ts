import type { AlphaEnv } from "./alpha-handler.ts";
import { bindRelayNodeRequest } from "./node-identity.ts";
import {
	RELAY_PROTOCOL_VERSION,
	type RelayWakeupMessage,
} from "./protocol.ts";

export function createAlphaQueueHandler() {
	return async (batch: MessageBatch<RelayWakeupMessage>, env: AlphaEnv) => {
		for (const message of batch.messages) {
			const payload = message.body;
			if (
				payload.protocolVersion !== RELAY_PROTOCOL_VERSION ||
				!/^[0-9a-f]{64}$/.test(payload.nodeId) ||
				!payload.commandId
			) {
				console.error("[alpha] rejected malformed queue wakeup", payload);
				message.ack();
				continue;
			}
			try {
				const request = bindRelayNodeRequest(
					"https://alpha.internal/internal/wake",
					{ method: "POST" },
					payload.nodeId,
				);
				const response = await env.NODES.getByName(payload.nodeId).fetch(request);
				if (!response.ok) throw new Error(`wake returned ${response.status}`);
				message.ack();
			} catch (error) {
				console.error("[alpha] queue wakeup failed", error);
				message.retry();
			}
		}
	};
}
