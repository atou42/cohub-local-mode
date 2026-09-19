export function formatCompactModelLabel(label: string): string {
	return label.trim();
}

export function formatCompactControlMeta(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (/^xhigh$/i.test(trimmed)) return "xH";
	const generationCount = /^gen\s+(\d+)$/i.exec(trimmed);
	if (generationCount?.[1]) return `G${generationCount[1]}`;
	return trimmed.slice(0, 1).toUpperCase();
}

export type CompactControlMetaTone = "thinking" | "speed" | "neutral";

const THINKING_LABELS = new Set([
	"off",
	"min",
	"minimal",
	"low",
	"med",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
]);

export function getCompactControlMetaTone(
	value: string,
): CompactControlMetaTone {
	const normalized = value.trim().toLowerCase();
	if (THINKING_LABELS.has(normalized)) return "thinking";
	if (normalized === "fast" || normalized === "priority") return "speed";
	return "neutral";
}
