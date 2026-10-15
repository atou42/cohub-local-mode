import { m } from "$messages";
import { intlTag, type Locale } from "./core";

const formats = new Map<string, Intl.DateTimeFormat>();

function format(
	locale: Locale | undefined,
	options: Intl.DateTimeFormatOptions,
) {
	const key = `${intlTag(locale)}|${JSON.stringify(options)}`;
	let value = formats.get(key);
	if (!value) {
		value = new Intl.DateTimeFormat(intlTag(locale), options);
		formats.set(key, value);
	}
	return value;
}

export function formatDateTime(
	dateStr: string | null | undefined,
	locale?: Locale,
): string {
	if (!dateStr) return "—";
	return format(locale, {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).format(new Date(dateStr));
}

export function formatShortDateTime(
	dateStr: string | null | undefined,
	locale?: Locale,
	timeZone?: string,
): string {
	if (!dateStr) return "—";
	return format(locale, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		...(timeZone ? { timeZone } : {}),
	}).format(new Date(dateStr));
}

export function formatTimeAgo(at: number, now: number, locale: Locale) {
	const ms = now - at;
	if (!Number.isFinite(ms) || ms < 45_000)
		return m.time_just_now({}, { locale });
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return m.time_ago_min({ n: minutes }, { locale });
	const hours = Math.round(minutes / 60);
	return hours < 24
		? m.time_ago_hour({ n: hours }, { locale })
		: m.time_ago_day({ n: Math.round(hours / 24) }, { locale });
}
