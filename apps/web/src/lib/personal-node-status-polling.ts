export const PERSONAL_NODE_STATUS_REFRESH_MS = 15_000;

export class PersonalNodeControlError extends Error {
	readonly retryAt: number;
	constructor(message: string, retryAt: number) {
		super(message);
		this.name = "PersonalNodeControlError";
		this.retryAt = retryAt;
	}
}

export function startPersonalNodeStatusPolling(input: {
	refresh: () => Promise<void>;
	onError: (error: unknown) => void;
	visibility?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
}) {
	const visibility = input.visibility ?? document;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let inFlight: Promise<void> | null = null;
	let failures = 0;
	let nextAt = 0;
	const clear = () => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	};
	const schedule = () => {
		clear();
		if (!stopped && visibility.visibilityState === "visible") {
			timer = setTimeout(() => { void refresh(); }, Math.max(0, nextAt - Date.now()));
		}
	};
	const refresh = () => {
		if (stopped || visibility.visibilityState !== "visible") return Promise.resolve();
		if (inFlight) return inFlight;
		if (Date.now() < nextAt) { schedule(); return Promise.resolve(); }
		const operation = Promise.resolve().then(input.refresh).then(() => {
			failures = 0;
			nextAt = Date.now() + PERSONAL_NODE_STATUS_REFRESH_MS;
		}).catch(error => {
			if (stopped) return;
			failures++;
			nextAt = Math.max(Date.now() + Math.min(120_000, 15_000 * 2 ** Math.min(failures, 3)), error instanceof PersonalNodeControlError ? error.retryAt : 0);
			input.onError(error);
		}).finally(() => {
			if (inFlight === operation) inFlight = null;
			schedule();
		});
		inFlight = operation;
		return operation;
	};
	const onVisibility = () => {
		clear();
		if (visibility.visibilityState === "visible") {
			// A foreground refresh must not defeat a server-requested cooldown.
			if (failures === 0) nextAt = 0;
			void refresh();
		}
	};
	visibility.addEventListener("visibilitychange", onVisibility);
	return {
		ready: refresh(),
		stop: () => { stopped = true; clear(); visibility.removeEventListener("visibilitychange", onVisibility); },
	};
}
