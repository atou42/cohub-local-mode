export type Locale = "en" | "zh-CN";

export function intlTag(locale: string | undefined): "en-US" | "zh-CN" {
	return locale?.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
