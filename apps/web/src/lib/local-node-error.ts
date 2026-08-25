const LOCAL_UPSTREAM_ERROR_PATTERN =
	/(?:<!doctype\s+html|<html\b|\b502\b|bad gateway|cloudflare|fetch failed|failed to fetch|networkerror)/i;

export function localNodeErrorMessage(
	error: unknown,
	fallback: string,
	isLocalSpace: boolean,
) {
	const message =
		error instanceof Error && error.message.trim()
			? error.message.trim()
			: fallback;
	return isLocalSpace && LOCAL_UPSTREAM_ERROR_PATTERN.test(message)
		? "Local Mac is offline"
		: message;
}

export function localRelayCommandFailure(command: {
	errorCode: string | null;
	errorMessage: string | null;
	result: { status: number; body: string } | null;
}) {
	let code = command.errorCode || "local_node_failed";
	let message =
		command.errorMessage || "Local node could not complete the message";
	if (
		command.result &&
		(command.result.status < 200 || command.result.status >= 300)
	) {
		try {
			const payload = JSON.parse(command.result.body) as unknown;
			if (payload && typeof payload === "object" && !Array.isArray(payload)) {
				const record = payload as Record<string, unknown>;
				if (typeof record.code === "string" && record.code.trim()) {
					code = record.code.trim();
				}
				if (typeof record.message === "string" && record.message.trim()) {
					message = record.message.trim();
				}
			}
		} catch {
			// Keep the relay-level failure when the Local API body is not JSON.
		}
	}
	return { code, message };
}
