export type RetryOptions = {
	maxAttempts: number;
	baseDelayMs: number;
	signal?: AbortSignal;
};

export const NATIVE_REGISTRATION_HEARTBEAT_MS = 5 * 60 * 1_000;

export type HeartbeatScheduler = {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
};

const defaultHeartbeatScheduler: HeartbeatScheduler = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) =>
		clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class NativeRegistrationHeartbeat {
	private timer: unknown = null;
	private stopped = true;
	private readonly scheduler: HeartbeatScheduler;

	constructor(scheduler: HeartbeatScheduler = defaultHeartbeatScheduler) {
		this.scheduler = scheduler;
	}

	start(input: { isEligible: () => boolean; refresh: () => Promise<void> }) {
		if (!this.stopped) return;
		this.stopped = false;
		const schedule = () => {
			if (this.stopped) return;
			this.timer = this.scheduler.setTimeout(() => {
				this.timer = null;
				const refresh = input.isEligible()
					? input.refresh()
					: Promise.resolve();
				void refresh.then(schedule, schedule);
			}, NATIVE_REGISTRATION_HEARTBEAT_MS);
		};
		schedule();
	}

	stop() {
		if (this.stopped) return;
		this.stopped = true;
		if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
		this.timer = null;
	}
}

function abortError() {
	return new DOMException("Operation aborted", "AbortError");
}

function waitForRetry(delayMs: number, signal?: AbortSignal) {
	if (signal?.aborted) return Promise.reject(abortError());
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function runWithBoundedRetry<T>(
	operation: () => Promise<T>,
	options: RetryOptions,
): Promise<T> {
	if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
		throw new Error("maxAttempts must be a positive integer");
	}
	if (!Number.isFinite(options.baseDelayMs) || options.baseDelayMs < 0) {
		throw new Error("baseDelayMs must be non-negative");
	}
	let lastError: unknown;
	for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
		if (options.signal?.aborted) throw abortError();
		try {
			return await operation();
		} catch (error) {
			lastError = error;
			if (attempt + 1 >= options.maxAttempts) break;
			await waitForRetry(options.baseDelayMs * 2 ** attempt, options.signal);
		}
	}
	throw lastError;
}

export class DirtyAsyncCoordinator {
	private requestedGeneration = 0;
	private completedGeneration = 0;
	private latestRun: (() => Promise<void>) | null = null;
	private drainPromise: Promise<void> | null = null;
	private stopped = false;

	request(run: () => Promise<void>): Promise<void> {
		if (this.stopped) return Promise.resolve();
		this.latestRun = run;
		this.requestedGeneration += 1;
		return this.ensureDrain();
	}

	private ensureDrain(): Promise<void> {
		if (!this.drainPromise) {
			this.drainPromise = this.drain().finally(() => {
				this.drainPromise = null;
				if (
					!this.stopped &&
					this.completedGeneration < this.requestedGeneration &&
					this.latestRun
				) {
					void this.ensureDrain();
				}
			});
		}
		return this.drainPromise;
	}

	stop() {
		this.stopped = true;
		this.latestRun = null;
		return this.drainPromise ?? Promise.resolve();
	}

	private async drain() {
		while (
			!this.stopped &&
			this.completedGeneration < this.requestedGeneration
		) {
			const generation = this.requestedGeneration;
			const run = this.latestRun;
			if (!run) return;
			try {
				await run();
			} finally {
				this.completedGeneration = generation;
			}
		}
	}
}

type ProjectionRegistrationRequest = {
	key: string;
	force?: boolean;
	register: () => Promise<void>;
	onSuccess?: () => void;
	onFailure?: () => void;
};

export class ProjectionRegistrationCoordinator {
	private readonly dirty = new DirtyAsyncCoordinator();
	private readonly abortController = new AbortController();
	private pending: ProjectionRegistrationRequest | null = null;
	private attemptedKey = "";
	private committedKey = "";
	private stopped = false;
	private readonly retry: Omit<RetryOptions, "signal">;

	constructor(retry: Omit<RetryOptions, "signal">) {
		this.retry = retry;
	}

	get committedProjectionKey() {
		return this.committedKey;
	}

	request(request: ProjectionRegistrationRequest) {
		if (this.stopped) return Promise.resolve();
		if (
			!request.force &&
			(request.key === this.committedKey || request.key === this.attemptedKey)
		) {
			return Promise.resolve();
		}
		this.pending = request;
		this.attemptedKey = request.key;
		return this.dirty.request(() => this.runLatest());
	}

	stop() {
		if (this.stopped) return Promise.resolve();
		this.stopped = true;
		this.abortController.abort();
		return this.dirty.stop();
	}

	private async runLatest() {
		const request = this.pending;
		if (!request || this.stopped) return;
		try {
			await runWithBoundedRetry(request.register, {
				...this.retry,
				signal: this.abortController.signal,
			});
			if (request !== this.pending || this.stopped) return;
			this.committedKey = request.key;
			request.onSuccess?.();
		} catch (error) {
			if (
				request !== this.pending ||
				this.stopped ||
				(error instanceof DOMException && error.name === "AbortError")
			) {
				return;
			}
			request.onFailure?.();
		}
	}
}
