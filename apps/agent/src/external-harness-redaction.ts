const SENSITIVE_KEY =
	/^(?:token|access[_-]?token|refresh[_-]?token|auth[_-]?token|api[_-]?(?:key|token)|secret|password|passwd|git[_-]?token|authorization|credential|private[_-]?key)$/i;
const JSON_SECRET =
	/("(?:token|access[_-]?token|refresh[_-]?token|auth[_-]?token|api[_-]?key|api[_-]?token|secret|password|passwd|git[_-]?token|authorization|credential|private[_-]?key)"\s*:\s*")([^"]*)(")/gi;
const ASSIGNMENT_SECRET =
	/\b(token|access[_-]?token|refresh[_-]?token|auth[_-]?token|api[_-]?key|api[_-]?token|secret|password|passwd|authorization|credential|private[_-]?key)\s*([=:])\s*([^\s,;]+)/gi;
const BEARER_SECRET = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const JWT_SECRET = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g;
const PREFIX_SECRET =
	/\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|pat_[A-Za-z0-9_]{12,})\b/g;
const MAX_EXTERNAL_HARNESS_STRING_CHARS = 2 * 1024 * 1024;
const MAX_EXTERNAL_HARNESS_COLLECTION_ITEMS = 2048;
const MAX_EXTERNAL_HARNESS_VALUE_DEPTH = 32;
const TRUNCATED_OUTPUT_MARKER = "\n[output truncated by Cohub]";

function truncateExternalHarnessText(value: string) {
	if (value.length <= MAX_EXTERNAL_HARNESS_STRING_CHARS) return value;
	return `${value.slice(
		0,
		MAX_EXTERNAL_HARNESS_STRING_CHARS - TRUNCATED_OUTPUT_MARKER.length,
	)}${TRUNCATED_OUTPUT_MARKER}`;
}

function stripTerminalFormatting(value: string): string {
	let result = "";
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		const isCsi =
			code === 0x9b || (code === 0x1b && value.charCodeAt(index + 1) === 0x5b);
		if (!isCsi) {
			result += value[index];
			continue;
		}
		if (code === 0x1b) index += 1;
		while (index + 1 < value.length) {
			index += 1;
			const next = value.charCodeAt(index);
			if (next >= 0x40 && next <= 0x7e) break;
		}
	}
	return result;
}

export function redactExternalHarnessText(value: string): string {
	if (!value) return value;
	return truncateExternalHarnessText(stripTerminalFormatting(truncateExternalHarnessText(value))
		.replace(JSON_SECRET, "$1[redacted]$3")
		.replace(BEARER_SECRET, "Bearer [redacted]")
		.replace(JWT_SECRET, "[redacted jwt]")
		.replace(PREFIX_SECRET, "[redacted token]")
		.replace(ASSIGNMENT_SECRET, "$1$2[redacted]"));
}

export function redactExternalHarnessValue(
	value: unknown,
	key?: string,
	depth = 0,
): unknown {
	if (key && SENSITIVE_KEY.test(key)) return "[redacted]";
	if (typeof value === "string") return redactExternalHarnessText(value);
	if (depth >= MAX_EXTERNAL_HARNESS_VALUE_DEPTH) {
		return "[nested value truncated by Cohub]";
	}
	if (Array.isArray(value)) {
		const output = value
			.slice(0, MAX_EXTERNAL_HARNESS_COLLECTION_ITEMS)
			.map((item) => redactExternalHarnessValue(item, undefined, depth + 1));
		if (value.length > output.length) {
			output.push(`[${value.length - output.length} items truncated by Cohub]`);
		}
		return output;
	}
	if (!value || typeof value !== "object") return value;
	const output: Record<string, unknown> = {};
	const entries = Object.entries(value as Record<string, unknown>);
	for (const [entryKey, entryValue] of entries.slice(
		0,
		MAX_EXTERNAL_HARNESS_COLLECTION_ITEMS,
	)) {
		output[entryKey] = redactExternalHarnessValue(
			entryValue,
			entryKey,
			depth + 1,
		);
	}
	if (entries.length > MAX_EXTERNAL_HARNESS_COLLECTION_ITEMS) {
		output._cohubTruncatedKeys =
			entries.length - MAX_EXTERNAL_HARNESS_COLLECTION_ITEMS;
	}
	return output;
}
