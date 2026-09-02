export function claimCodexInterrupt(state: {
	abortRequested: boolean;
	interruptRequested: boolean;
	threadId: string;
	turnId: string | null;
}) {
	if (!state.abortRequested || state.interruptRequested || !state.turnId) {
		return null;
	}
	state.interruptRequested = true;
	return { threadId: state.threadId, turnId: state.turnId };
}
