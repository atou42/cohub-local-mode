import { performance } from "node:perf_hooks";

/** Redis command completion is not a clock: even a hung renewal must expire locally. */
export function monitorSessionLease(input: {
  ttlMs: number;
  intervalMs: number;
  acquiredAt: number;
  renew: () => Promise<unknown>;
  onError: (error: unknown) => void;
  now?: () => number;
}) {
  const now = input.now ?? (() => performance.now());
  const controller = new AbortController();
  const margin = Math.min(input.intervalMs, input.ttlMs / 4);
  let deadline = input.acquiredAt + input.ttlMs - margin;
  let closed = false;
  let inFlight = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const lose = () => controller.abort(new Error("Session execution lease lost"));
  const arm = () => {
    clearTimeout(expiry);
    const remaining = deadline - now();
    if (remaining <= 0) lose();
    else expiry = setTimeout(lose, remaining);
  };
  const tick = async () => {
    if (closed || controller.signal.aborted || inFlight) return;
    if (now() >= deadline) { lose(); return; }
    inFlight = true;
    const startedAt = now();
    try {
      const renewed = await input.renew();
      if (closed || controller.signal.aborted) return;
      if (renewed !== 1 || now() >= deadline) { lose(); return; }
      // Count from dispatch, never from a delayed response that could revive an expired lease.
      deadline = startedAt + input.ttlMs - margin;
      arm();
    } catch (error) {
      if (!closed) input.onError(error);
    } finally { inFlight = false; }
  };
  arm();
  const timer = setInterval(() => { void tick(); }, Math.min(input.intervalMs, input.ttlMs / 3));
  return {
    signal: controller.signal,
    stop() { closed = true; clearInterval(timer); clearTimeout(expiry); },
  };
}
