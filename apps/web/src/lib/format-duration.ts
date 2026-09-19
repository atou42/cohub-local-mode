import { toIntlTag } from "$lib/i18n/format";
import type { Locale } from "$lib/i18n/locale";

const UNIT_MS = {
	en: "ms",
	zh: "毫秒",
};

/** Compact elapsed time for dense status rows, e.g. "4m6s". */
export function formatDurationMs(ms: number, _locale?: Locale): string {
	if (ms < 1000) return `${Math.max(1, Math.round(ms))}${UNIT_MS.en}`;
	if (ms < 10_000) {
		const seconds = Math.round(ms / 100) / 10;
		if (seconds < 10) return `${seconds.toFixed(1)}s`;
	}
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60)
		return seconds > 0 ? `${totalMinutes}m${seconds}s` : `${totalMinutes}m`;
	const hours = Math.floor(totalMinutes / 60);
	const remainingMinutes = totalMinutes % 60;
	return remainingMinutes > 0 ? `${hours}h${remainingMinutes}m` : `${hours}h`;
}

export function formatDurationDetail(
	ms: number,
	label = "Duration",
	locale?: Locale,
): string {
	return `${label}: ${formatDurationMs(ms, locale)} (${Math.round(ms).toLocaleString(toIntlTag(locale))} ms)`;
}

export function isDisplayableDurationMs(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}
