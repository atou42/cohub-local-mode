import type { HeartbeatScheduler } from "./async-coordination";
import { type RetryOptions, runWithBoundedRetry } from "./async-coordination";
import { nativeStateResetMessage } from "./messages";
import type {
	NativeActivityRegistrationIdentity,
	NativeDeviceRegistrationIdentity,
	NativeRelayRegistrationAdapter,
} from "./relay-registration";

export async function resetNativeAccountState(input: {
	preferenceInstallationId: string | null;
	device: NativeDeviceRegistrationIdentity | null;
	activities: NativeActivityRegistrationIdentity[];
	relay: Pick<
		NativeRelayRegistrationAdapter,
		"deletePreferences" | "deleteDevice" | "deleteActivity"
	>;
	resetNativeState: () => Promise<void>;
	retry?: Omit<RetryOptions, "signal">;
}) {
	const retry = input.retry ?? { maxAttempts: 3, baseDelayMs: 250 };
	const preferenceInstallationId = input.preferenceInstallationId;
	if (preferenceInstallationId) {
		await runWithBoundedRetry(
			() => input.relay.deletePreferences(preferenceInstallationId),
			retry,
		);
	}
	const deletes: Array<Promise<void>> = [];
	const device = input.device;
	if (device) {
		deletes.push(
			runWithBoundedRetry(
				() => input.relay.deleteDevice(device.installationId),
				retry,
			),
		);
	}
	for (const activity of input.activities) {
		deletes.push(
			runWithBoundedRetry(
				() =>
					input.relay.deleteActivity(
						activity.installationId,
						activity.activityId,
					),
				retry,
			),
		);
	}
	await Promise.all(deletes);
	await input.resetNativeState();
}

export const NATIVE_STATE_RESET_TIMEOUT_MS = 5_000;

const defaultResetScheduler: HeartbeatScheduler = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) =>
		clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type PendingReset = {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
	timer: unknown;
};

export class NativeStateResetAcknowledger {
	private pending: PendingReset | null = null;
	private readonly scheduler: HeartbeatScheduler;

	constructor(scheduler: HeartbeatScheduler = defaultResetScheduler) {
		this.scheduler = scheduler;
	}

	request(postMessage: (message: unknown) => void) {
		if (this.pending) return this.pending.promise;
		let resolve!: () => void;
		let reject!: (error: Error) => void;
		const promise = new Promise<void>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		const timer = this.scheduler.setTimeout(() => {
			this.rejectPending(
				new Error("Native state reset acknowledgement timed out"),
			);
		}, NATIVE_STATE_RESET_TIMEOUT_MS);
		this.pending = { promise, resolve, reject, timer };
		try {
			postMessage(nativeStateResetMessage());
		} catch (error) {
			this.rejectPending(
				error instanceof Error
					? error
					: new Error("Native state reset message failed"),
			);
		}
		return promise;
	}

	handleEvent(detail: unknown) {
		if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
			return false;
		}
		const event = detail as Record<string, unknown>;
		if (event.schemaVersion !== 1) return false;
		if (event.type === "state.reset.completed") {
			this.resolvePending();
			return true;
		}
		if (event.type === "action.failed" && event.action === "state.reset") {
			this.rejectPending(new Error("Native state reset failed"));
			return true;
		}
		return false;
	}

	stop() {
		this.rejectPending(new Error("Native state reset stopped"));
	}

	private resolvePending() {
		const pending = this.pending;
		if (!pending) return;
		this.pending = null;
		this.scheduler.clearTimeout(pending.timer);
		pending.resolve();
	}

	private rejectPending(error: Error) {
		const pending = this.pending;
		if (!pending) return;
		this.pending = null;
		this.scheduler.clearTimeout(pending.timer);
		pending.reject(error);
	}
}
