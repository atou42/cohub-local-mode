export function normalizeGrokAcpPrompt(prompt: string): string {
	// Grok 1.0.5 advertises /context over ACP but only /session-info emits
	// the requested context report to ACP clients.
	return /^\s*\/context\s*$/u.test(prompt) ? "/session-info" : prompt;
}
