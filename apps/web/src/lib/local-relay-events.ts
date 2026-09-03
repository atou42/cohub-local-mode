import { LOCAL_RELAY_BROWSER_PROTOCOL_VERSION } from "@cohub/protocol/local-relay-compatibility";

/** Browser event-plane wire version, independent from the Node command plane. */
export const RELAY_BROWSER_PROTOCOL_VERSION =
	LOCAL_RELAY_BROWSER_PROTOCOL_VERSION;
export const RELAY_EVENTS_RECONNECT_MIN_MS = 1_000;
export const RELAY_EVENTS_RECONNECT_MAX_MS = 30_000;
export const RELAY_EVENTS_UNAVAILABLE_AFTER = 2;

export type LocalRelayCommandStatus =
	| "accepted"
	| "queued"
	| "claimed"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled";

export type LocalRelayHttpResult = {
	status: number;
	headers: Record<string, string>;
	body: string;
};

export type LocalRelayEventCommand = {
	id: string;
	status: LocalRelayCommandStatus;
	errorCode: string | null;
	errorMessage: string | null;
	result: LocalRelayHttpResult | null;
};

export type LocalRelayTurnEvent = {
	id: string;
	kind: "turn.completed";
	spaceId: string;
	sessionId: string;
	turnId: string;
	completedAt: string;
	turn: Record<string, unknown> | null;
	truncated: boolean;
};

export type LocalRelayBrowserMessage =
	| {
			protocolVersion: typeof RELAY_BROWSER_PROTOCOL_VERSION;
			type: "snapshot";
			commands: LocalRelayEventCommand[];
			events: LocalRelayTurnEvent[];
	  }
	| {
			protocolVersion: typeof RELAY_BROWSER_PROTOCOL_VERSION;
			type: "command.updated";
			command: LocalRelayEventCommand;
	  }
	| {
			protocolVersion: typeof RELAY_BROWSER_PROTOCOL_VERSION;
			type: "turn.event";
			event: LocalRelayTurnEvent;
	  };

export type ParseLocalRelayBrowserMessageResult =
	| { ok: true; message: LocalRelayBrowserMessage }
	| {
			ok: false;
			reason:
				| "invalid-json"
				| "not-object"
				| "unknown-type"
				| "invalid-fields"
				| "protocol-mismatch";
			warning?: string;
	  };

export type LocalRelayEventHandlers = {
	onSnapshot?: (message: {
		commands: LocalRelayEventCommand[];
		events: LocalRelayTurnEvent[];
	}) => void;
	onCommandUpdated?: (command: LocalRelayEventCommand) => void;
	onTurnEvent?: (event: LocalRelayTurnEvent) => void;
	onAvailable?: () => void;
	onUnavailable?: () => void;
};

const COMMAND_STATUSES = new Set<LocalRelayCommandStatus>([
	"accepted",
	"queued",
	"claimed",
	"running",
	"succeeded",
	"failed",
	"cancelled",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function parseCommand(value: unknown): LocalRelayEventCommand | null {
	if (!isRecord(value)) return null;
	const id = asString(value.id);
	const status = asString(value.status);
	if (
		!id ||
		!status ||
		!COMMAND_STATUSES.has(status as LocalRelayCommandStatus)
	) {
		return null;
	}
	let result: LocalRelayHttpResult | null = null;
	if (isRecord(value.result)) {
		const body = typeof value.result.body === "string" ? value.result.body : "";
		const statusCode =
			typeof value.result.status === "number" &&
			Number.isInteger(value.result.status)
				? value.result.status
				: 0;
		const headers = isRecord(value.result.headers)
			? Object.fromEntries(
					Object.entries(value.result.headers).flatMap(([key, item]) =>
						typeof item === "string" ? [[key, item]] : [],
					),
				)
			: {};
		result = { status: statusCode, headers, body };
	}
	return {
		id,
		status: status as LocalRelayCommandStatus,
		errorCode: typeof value.errorCode === "string" ? value.errorCode : null,
		errorMessage:
			typeof value.errorMessage === "string" ? value.errorMessage : null,
		result,
	};
}

function parseTurnEvent(value: unknown): LocalRelayTurnEvent | null {
	if (!isRecord(value)) return null;
	const id = asString(value.id);
	const spaceId = asString(value.spaceId);
	const sessionId = asString(value.sessionId);
	const turnId = asString(value.turnId);
	const completedAt = asString(value.completedAt);
	if (
		!id ||
		value.kind !== "turn.completed" ||
		!spaceId ||
		!sessionId ||
		!turnId ||
		!completedAt ||
		typeof value.truncated !== "boolean"
	) {
		return null;
	}
	if (value.turn !== null && !isRecord(value.turn)) return null;
	return {
		id,
		kind: "turn.completed",
		spaceId,
		sessionId,
		turnId,
		completedAt,
		turn: value.turn,
		truncated: value.truncated,
	};
}

export function parseLocalRelayBrowserMessage(
	raw: unknown,
): ParseLocalRelayBrowserMessageResult {
	let value: unknown = raw;
	if (typeof raw === "string") {
		try {
			value = JSON.parse(raw);
		} catch {
			return {
				ok: false,
				reason: "invalid-json",
				warning: "[local-relay] event message is not valid JSON",
			};
		}
	}
	if (!isRecord(value)) {
		return {
			ok: false,
			reason: "not-object",
			warning: "[local-relay] event message is not an object",
		};
	}
	if (value.protocolVersion !== RELAY_BROWSER_PROTOCOL_VERSION) {
		return {
			ok: false,
			reason: "protocol-mismatch",
			warning: `[local-relay] event message protocolVersion does not match ${RELAY_BROWSER_PROTOCOL_VERSION}`,
		};
	}
	const type = asString(value.type);
	if (!type) {
		return {
			ok: false,
			reason: "invalid-fields",
			warning: "[local-relay] event message is missing type",
		};
	}
	if (type === "snapshot") {
		if (!Array.isArray(value.commands) || !Array.isArray(value.events)) {
			return {
				ok: false,
				reason: "invalid-fields",
				warning: "[local-relay] snapshot is missing commands or events",
			};
		}
		const commands: LocalRelayEventCommand[] = [];
		for (const item of value.commands) {
			const command = parseCommand(item);
			if (command) commands.push(command);
			else {
				console.warn("[local-relay] snapshot command dropped (invalid fields)");
			}
		}
		const events: LocalRelayTurnEvent[] = [];
		for (const item of value.events) {
			const event = parseTurnEvent(item);
			if (event) events.push(event);
			else {
				console.warn("[local-relay] snapshot event dropped (invalid fields)");
			}
		}
		return {
			ok: true,
			message: {
				protocolVersion: RELAY_BROWSER_PROTOCOL_VERSION,
				type: "snapshot",
				commands,
				events,
			},
		};
	}
	if (type === "command.updated") {
		const command = parseCommand(value.command);
		if (!command) {
			return {
				ok: false,
				reason: "invalid-fields",
				warning: "[local-relay] command.updated is missing a valid command",
			};
		}
		return {
			ok: true,
			message: {
				protocolVersion: RELAY_BROWSER_PROTOCOL_VERSION,
				type: "command.updated",
				command,
			},
		};
	}
	if (type === "turn.event") {
		const event = parseTurnEvent(value.event);
		if (!event) {
			return {
				ok: false,
				reason: "invalid-fields",
				warning: "[local-relay] turn.event is missing a valid event",
			};
		}
		return {
			ok: true,
			message: {
				protocolVersion: RELAY_BROWSER_PROTOCOL_VERSION,
				type: "turn.event",
				event,
			},
		};
	}
	return { ok: false, reason: "unknown-type" };
}

export function resolveLocalRelayEventsUrl(
	path: string,
	location?: { protocol: string; host: string } | null,
) {
	if (!location) return path;
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${location.host}${path}`;
}

export function nextRelayEventReconnectDelay(
	attempt: number,
	random: () => number = Math.random,
) {
	const exp = Math.min(
		RELAY_EVENTS_RECONNECT_MAX_MS,
		RELAY_EVENTS_RECONNECT_MIN_MS * 2 ** Math.max(0, attempt),
	);
	const jitter = 0.5 + random() * 0.5;
	return Math.min(RELAY_EVENTS_RECONNECT_MAX_MS, Math.round(exp * jitter));
}

type EventSocket = {
	close: (code?: number, reason?: string) => void;
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onerror: ((event: unknown) => void) | null;
	onclose: ((event: unknown) => void) | null;
};

export function connectLocalRelayEvents(input: {
	url: string;
	handlers: LocalRelayEventHandlers;
	signal?: AbortSignal;
	WebSocket?: new (url: string) => EventSocket;
	random?: () => number;
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
}): { close(): void } {
	const WebSocketImpl =
		input.WebSocket ??
		(globalThis.WebSocket as unknown as
			| (new (
					url: string,
			  ) => EventSocket)
			| undefined);
	const setTimeoutFn: (fn: () => void, ms: number) => unknown =
		input.setTimeout ?? setTimeout;
	const clearTimeoutFn: (handle: unknown) => void =
		input.clearTimeout ?? ((handle) => clearTimeout(handle as number));
	const random = input.random ?? Math.random;
	let closed = false;
	let socket: EventSocket | null = null;
	let reconnectTimer: unknown = null;
	let attempt = 0;
	let consecutiveFailures = 0;
	let unavailableNotified = false;

	const clearReconnect = () => {
		if (reconnectTimer != null) {
			clearTimeoutFn(reconnectTimer);
			reconnectTimer = null;
		}
	};

	const markUnavailable = () => {
		if (unavailableNotified || closed) return;
		unavailableNotified = true;
		input.handlers.onUnavailable?.();
	};

	const scheduleReconnect = () => {
		if (closed) return;
		consecutiveFailures += 1;
		if (consecutiveFailures >= RELAY_EVENTS_UNAVAILABLE_AFTER)
			markUnavailable();
		const delay = nextRelayEventReconnectDelay(attempt, random);
		attempt += 1;
		clearReconnect();
		reconnectTimer = setTimeoutFn(() => {
			reconnectTimer = null;
			connect();
		}, delay);
	};

	const detachSocket = () => {
		if (!socket) return;
		socket.onopen = null;
		socket.onmessage = null;
		socket.onerror = null;
		socket.onclose = null;
		try {
			socket.close();
		} catch {
			// ignore close errors on a socket that never opened
		}
		socket = null;
	};

	const dispatchMessage = (data: unknown) => {
		const parsed = parseLocalRelayBrowserMessage(data);
		if (!parsed.ok) {
			if (parsed.warning) console.warn(parsed.warning);
			return;
		}
		if (parsed.message.type === "snapshot") {
			attempt = 0;
			consecutiveFailures = 0;
			unavailableNotified = false;
			input.handlers.onAvailable?.();
			input.handlers.onSnapshot?.(parsed.message);
			return;
		}
		if (parsed.message.type === "command.updated") {
			input.handlers.onCommandUpdated?.(parsed.message.command);
			return;
		}
		input.handlers.onTurnEvent?.(parsed.message.event);
	};

	const connect = () => {
		if (closed) return;
		if (!WebSocketImpl) {
			markUnavailable();
			scheduleReconnect();
			return;
		}
		detachSocket();
		let next: EventSocket;
		try {
			next = new WebSocketImpl(input.url);
		} catch (error) {
			console.warn("[local-relay] event socket failed to open", error);
			scheduleReconnect();
			return;
		}
		socket = next;
		next.onmessage = (event) => {
			if (closed) return;
			dispatchMessage(event.data);
		};
		next.onerror = () => {
			// onclose follows; count the failure there to avoid double-count
		};
		next.onclose = () => {
			if (socket === next) socket = null;
			if (closed) return;
			scheduleReconnect();
		};
	};

	const close = () => {
		if (closed) return;
		closed = true;
		input.signal?.removeEventListener("abort", close);
		clearReconnect();
		detachSocket();
	};

	if (input.signal?.aborted) return { close };
	input.signal?.addEventListener("abort", close, { once: true });
	connect();
	return { close };
}
