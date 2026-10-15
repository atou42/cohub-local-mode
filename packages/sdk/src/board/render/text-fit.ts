import { CanvasTextMetrics, type Text } from "pixi.js";

export function ellipsizeWrappedLines(
	lines: string[],
	maxLines: number,
): string {
	if (maxLines <= 0 || lines.length === 0) return "";
	if (lines.length <= maxLines) return lines.join("\n");
	const kept = lines.slice(0, maxLines);
	const lastIndex = kept.length - 1;
	const last = (kept[lastIndex] ?? "").replace(/\s+$/u, "");
	kept[lastIndex] = last ? `${last}…` : "…";
	return kept.join("\n");
}

export function fitLineWithEllipsis(
	line: string,
	wrapWidth: number,
	measureWidth: (value: string) => number,
): string {
	const trimmed = line.replace(/\s+$/u, "");
	if (!trimmed) return "…";
	const full = `${trimmed}…`;
	if (measureWidth(full) <= wrapWidth) return full;

	let lo = 0;
	let hi = trimmed.length;
	let best = "…";
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const candidate = mid > 0 ? `${trimmed.slice(0, mid)}…` : "…";
		if (measureWidth(candidate) <= wrapWidth) {
			best = candidate;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return best;
}

export function fitTextToLines(
	text: Text,
	value: string,
	maxLines: number,
	wrapWidth: number,
): void {
	const width = Math.max(1, wrapWidth);
	text.style.wordWrapWidth = width;
	if (!value || maxLines <= 0) {
		if (text.text !== "") text.text = "";
		return;
	}

	const charCap = Math.max(maxLines * Math.ceil(width), maxLines * 4);
	const sample = value.length > charCap ? value.slice(0, charCap) : value;
	const metrics = CanvasTextMetrics.measureText(sample, text.style);
	const overflowed = metrics.lines.length > maxLines || sample !== value;
	if (!overflowed) {
		if (text.text !== value) text.text = value;
		return;
	}

	const keptCount = Math.min(maxLines, metrics.lines.length);
	const kept = metrics.lines.slice(0, keptCount);
	const lastIndex = kept.length - 1;
	const probe = text.style.clone();
	probe.wordWrap = false;
	kept[lastIndex] = fitLineWithEllipsis(
		kept[lastIndex] ?? "",
		width,
		(candidate) => CanvasTextMetrics.measureText(candidate, probe).width,
	);
	const fitted = kept.join("\n");
	if (text.text !== fitted) text.text = fitted;
}

export function fitTextToWidth(text: Text, value: string, width: number): void {
	text.style.wordWrap = false;
	const measure = (candidate: string) => CanvasTextMetrics.measureText(candidate, text.style).width;
	const fitted = !value || measure(value) <= width ? value : fitLineWithEllipsis(value, width, measure);
	if (text.text !== fitted) text.text = fitted;
}
