type AuthInvalidationCleanup = () => Promise<void>;

let cleanup: AuthInvalidationCleanup | null = null;
let cleanupInFlight: Promise<void> | null = null;

export function registerAuthInvalidationCleanup(
	nextCleanup: AuthInvalidationCleanup,
) {
	cleanup = nextCleanup;
	return () => {
		if (cleanup === nextCleanup) cleanup = null;
	};
}

export function runAuthInvalidationCleanup() {
	if (cleanupInFlight) return cleanupInFlight;
	if (!cleanup) return Promise.resolve();
	const operation = Promise.resolve().then(cleanup);
	const inFlight = operation.finally(() => {
		if (cleanupInFlight === inFlight) cleanupInFlight = null;
	});
	cleanupInFlight = inFlight;
	return cleanupInFlight;
}
