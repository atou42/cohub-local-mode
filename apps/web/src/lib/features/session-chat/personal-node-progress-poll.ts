type TimerHandle = number | ReturnType<typeof setInterval>;

export function createPersonalNodeProgressPoller(options: {
	poll: (key: string) => Promise<void>;
	onError: (error: unknown) => void;
	intervalMs?: number;
	setIntervalFn?: (callback: () => void, intervalMs: number) => TimerHandle;
	clearIntervalFn?: (handle: TimerHandle) => void;
}) {
	const intervalMs = options.intervalMs ?? 1_200;
	const setIntervalFn: (
		callback: () => void,
		intervalMs: number,
	) => TimerHandle =
		options.setIntervalFn ??
		((callback, delay) => setInterval(callback, delay));
	const clearIntervalFn: (handle: TimerHandle) => void =
		options.clearIntervalFn ??
		((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
	let activeKey = "";
	let timer: TimerHandle | null = null;
	let inFlight = false;
	let disposed = false;

	function clear() {
		activeKey = "";
		if (timer) clearIntervalFn(timer);
		timer = null;
	}

	async function run(key: string) {
		if (disposed || key !== activeKey || inFlight) return;
		inFlight = true;
		try {
			await options.poll(key);
		} catch (error) {
			options.onError(error);
		} finally {
			inFlight = false;
		}
	}

	function sync(key: string | null) {
		if (disposed) return;
		const nextKey = key?.trim() ?? "";
		if (nextKey === activeKey) return;
		clear();
		if (!nextKey) return;
		activeKey = nextKey;
		void run(nextKey);
		timer = setIntervalFn(() => void run(nextKey), intervalMs);
	}

	function dispose() {
		disposed = true;
		clear();
	}

	return { sync, clear, dispose };
}
