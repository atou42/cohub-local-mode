import type { HarnessCapabilityCatalog } from "@neta-art/cohub";

export const HARNESS_CAPABILITY_CACHE_VERSION = 1;

function isString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function isHarnessCapabilityCatalog(
	value: unknown,
): value is HarnessCapabilityCatalog {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (
		record.version !== HARNESS_CAPABILITY_CACHE_VERSION ||
		!isString(record.fetchedAt) ||
		(record.harness !== "pi" &&
			record.harness !== "codex" &&
			record.harness !== "grok_build" &&
			record.harness !== "cursor") ||
		!Array.isArray(record.commands) ||
		!Array.isArray(record.skills)
	)
		return false;
	return (
		record.commands.every((item) => {
			if (!item || typeof item !== "object") return false;
			const command = item as Record<string, unknown>;
			return (
				isString(command.name) &&
				isString(command.description) &&
				isString(command.category) &&
				isString(command.insertionText) &&
				(command.argumentHint === undefined ||
					typeof command.argumentHint === "string")
			);
		}) &&
		record.skills.every((item) => {
			if (!item || typeof item !== "object") return false;
			const skill = item as Record<string, unknown>;
			return (
				isString(skill.name) &&
				isString(skill.description) &&
				isString(skill.insertionText) &&
				(skill.scope === "user" ||
					skill.scope === "repo" ||
					skill.scope === "system" ||
					skill.scope === "admin")
			);
		})
	);
}
