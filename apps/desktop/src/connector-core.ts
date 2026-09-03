export type ConnectorStatus = {
	state:
		| "signed-out"
		| "initializing"
		| "local-runtime-unavailable"
		| "connecting"
		| "connected"
		| "recovering"
		| "error"
		| "stopped";
	deviceId: string | null;
	message: string | null;
	attempt?: number;
	maxAttempts?: number;
};

export type StatusPresentation = {
	label: string;
	connected: boolean;
	detail: string | null;
};

const runtimeRestartDelays = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

export function nextRuntimeRestart(attempt: number) {
	if (!Number.isInteger(attempt) || attempt < 1) {
		throw new Error("Runtime restart attempt must be a positive integer");
	}
	const delayMs = runtimeRestartDelays[attempt - 1];
	return delayMs === undefined ? null : { attempt, delayMs };
}

export function isTrustedLegacyRuntimeCommand(
	command: string,
	userDataRoot: string,
) {
	if (!userDataRoot || /[\r\n\0]/.test(userDataRoot)) return false;
	return (
		command.includes(`${userDataRoot}/runtime/`) ||
		command.includes(`${userDataRoot}/local-data/`)
	);
}

export function statusPresentation(status: ConnectorStatus): StatusPresentation {
	if (status.state === "connected") {
		return { label: "Online", connected: true, detail: status.message };
	}
	if (status.state === "signed-out") {
		return { label: "Sign in required", connected: false, detail: status.message };
	}
	if (status.state === "initializing") {
		return { label: "Starting local services", connected: false, detail: status.message };
	}
	if (status.state === "connecting") {
		return { label: "Connecting to Cohub", connected: false, detail: status.message };
	}
	if (status.state === "recovering") {
		const attempt = status.attempt ?? 0;
		const maxAttempts = status.maxAttempts ?? runtimeRestartDelays.length;
		return {
			label: `Recovering local services (${attempt}/${maxAttempts})`,
			connected: false,
			detail: status.message,
		};
	}
	if (status.state === "stopped") {
		return { label: "Stopped", connected: false, detail: status.message };
	}
	return {
		label:
			status.state === "local-runtime-unavailable"
				? "Local services unavailable"
				: "Local services need attention",
		connected: false,
		detail: status.message,
	};
}

export const runtimeRestartLimit = runtimeRestartDelays.length;
