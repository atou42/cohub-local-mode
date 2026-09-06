export interface RuntimeStartupChild {
	readonly pid?: number;
	readonly exitCode: number | null;
	on(event: string, listener: (...args: any[]) => void): this;
	removeListener(event: string, listener: (...args: any[]) => void): this;
}

export type RuntimeStartupOptions = {
	child: RuntimeStartupChild;
	instanceId: string;
	verifyReady: () => Promise<boolean> | boolean;
	cleanup: () => Promise<void>;
	isCurrent?: () => boolean;
	onReady?: () => void;
	describeExit?: (code: number | null, signal: NodeJS.Signals | null) => Error;
	timeoutMs?: number;
	signal?: AbortSignal;
};

function asError(value: unknown) {
	return value instanceof Error ? value : new Error(String(value));
}

function defaultExitError(code: number | null, signal: NodeJS.Signals | null) {
	return new Error(`Local Cohub runtime stopped (${signal ?? code ?? "unknown"})`);
}

/** Waits for one runtime child to authenticate, cleaning it before failures return. */
export function waitForRuntimeStartup({
	child,
	instanceId,
	verifyReady,
	cleanup,
	isCurrent = () => child.exitCode === null,
	onReady,
	describeExit = defaultExitError,
	timeoutMs = 120_000,
	signal,
}: RuntimeStartupOptions): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		let verifying = false;
		const timeoutLabel = timeoutMs % 1_000 === 0
			? `${timeoutMs / 1_000} seconds`
			: `${timeoutMs} milliseconds`;
		let startupTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
			void fail(new Error(`Local Cohub runtime did not become ready within ${timeoutLabel}`));
		}, timeoutMs);

		const clearStartupTimeout = () => {
			if (startupTimeout) {
				clearTimeout(startupTimeout);
				startupTimeout = null;
			}
		};

		const onMessage = (message: unknown) => {
			if (
				settled ||
				verifying ||
				!message ||
				typeof message !== "object" ||
				Reflect.get(message, "type") !== "runtime-ready" ||
				Reflect.get(message, "instanceId") !== instanceId
			) {
				return;
			}
			verifying = true;
			void Promise.resolve()
				.then(() => verifyReady())
				.then((ready) => {
					if (settled) return;
					if (!ready) {
						void fail(new Error("Runtime identity check failed"));
						return;
					}
					if (!isCurrent() || child.exitCode !== null) {
						void fail(new Error("Local Cohub runtime startup became stale before readiness completed"));
						return;
					}
					settleSuccess();
				})
				.catch((error) => {
					void fail(error);
				})
				.finally(() => {
					verifying = false;
				});
		};
		const onError = (error: Error) => {
			void fail(error);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			void fail(describeExit(code, signal));
		};
		const onAbort = () => { void fail(signal?.reason ?? new Error("Runtime startup cancelled")); };

		const detach = () => {
			child.removeListener("message", onMessage);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			signal?.removeEventListener("abort", onAbort);
		};

		const settleSuccess = () => {
			if (settled) return;
			settled = true;
			clearStartupTimeout();
			detach();
			onReady?.();
			resolve();
		};

		const fail = async (reason: unknown) => {
			if (settled) return;
			settled = true;
			clearStartupTimeout();
			detach();
			const startupError = asError(reason);
			try {
				await cleanup();
				reject(startupError);
			} catch (cleanupError) {
				const terminationError = asError(cleanupError);
				reject(
					new AggregateError(
						[startupError, terminationError],
						`${startupError.message}; runtime cleanup failed: ${terminationError.message}`,
					),
				);
			}
		};

		child.on("message", onMessage);
		child.on("error", onError);
		child.on("exit", onExit);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}
