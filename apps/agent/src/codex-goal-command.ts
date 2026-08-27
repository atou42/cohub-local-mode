export type CodexGoalCommand =
	| { action: "get" }
	| { action: "clear" }
	| { action: "pause" | "resume" }
	| { action: "set"; objective: string };

export function parseCodexGoalCommand(prompt: string): CodexGoalCommand | null {
	const trimmed = prompt.trim();
	if (!/^\/goal(?:\s|$)/i.test(trimmed)) return null;
	const rest = trimmed.slice(5).trim();
	if (!rest || rest.toLowerCase() === "status") return { action: "get" };
	if (rest.toLowerCase() === "clear") return { action: "clear" };
	if (rest.toLowerCase() === "pause") return { action: "pause" };
	if (rest.toLowerCase() === "resume") return { action: "resume" };
	if (/^set(?:\s|$)/i.test(rest)) {
		const objective = rest.slice(3).trim();
		if (!objective) throw new Error("/goal set requires an objective");
		return { action: "set", objective };
	}
	return { action: "set", objective: rest };
}
