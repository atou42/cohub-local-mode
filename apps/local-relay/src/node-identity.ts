import { RelayProtocolError } from "./protocol.ts";

export const RELAY_NODE_IDENTITY_HEADER = "x-cohub-relay-node-id";
export const RELAY_NODE_IDENTITY_STORAGE_KEY = "meta:node-id";

const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,255}$/i;

function normalizedNodeId(value: string | null | undefined) {
	const normalized = value?.trim() ?? "";
	if (!normalized) return null;
	if (!NODE_ID_PATTERN.test(normalized)) {
		throw new RelayProtocolError(
			"relay_node_identity_invalid",
			"Relay node identity is invalid",
			500,
		);
	}
	return normalized;
}

export function decideRelayNodeIdentity(input: {
	stored?: string | null;
	requested?: string | null;
	configured?: string | null;
}) {
	const stored = normalizedNodeId(input.stored);
	const requested = normalizedNodeId(input.requested);
	const configured = normalizedNodeId(input.configured);
	if (stored) {
		if (requested && requested !== stored) {
			throw new RelayProtocolError(
				"relay_node_identity_mismatch",
				"Relay node identity does not match this Durable Object",
				403,
			);
		}
		return { nodeId: stored, shouldPersist: false };
	}
	const nodeId = requested ?? configured;
	if (!nodeId) {
		throw new RelayProtocolError(
			"relay_node_identity_missing",
			"Relay node identity is not bound",
			500,
		);
	}
	return { nodeId, shouldPersist: true };
}

export function bindRelayNodeRequest(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	nodeId: string,
) {
	const identity = decideRelayNodeIdentity({ requested: nodeId }).nodeId;
	const request = new Request(input, init);
	request.headers.set(RELAY_NODE_IDENTITY_HEADER, identity);
	return request;
}
