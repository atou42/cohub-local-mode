const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

function isActiveWriterError(error: unknown) {
	return error instanceof Error && /already has an active writer/i.test(error.message);
}

function abortableSleep(delayMs: number, signal?: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const timer = setTimeout(finish, delayMs);
		timer.unref?.();
		function abort() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			reject(new Error("aborted"));
		}
		function finish() {
			signal?.removeEventListener("abort", abort);
			resolve();
		}
		signal?.addEventListener("abort", abort, { once: true });
	});
}

export async function resumeCodexThreadWithRetry<T>(input: {
	resume: () => Promise<T>;
	delaysMs?: readonly number[];
	sleep?: (delayMs: number) => Promise<void>;
	onRetry?: (notice: { attempt: number; delayMs: number }) => void;
	signal?: AbortSignal;
}) {
	const delays = input.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await input.resume();
		} catch (error) {
			const delayMs = delays[attempt];
			if (!isActiveWriterError(error) || delayMs === undefined) throw error;
			input.onRetry?.({ attempt: attempt + 1, delayMs });
			await (input.sleep
				? input.sleep(delayMs)
				: abortableSleep(delayMs, input.signal));
		}
	}
}
