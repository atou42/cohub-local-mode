const DATABASE_DISPLAY_NAME_LIMIT = 255;

function hasUnsafeDisplayNameCharacter(value: string) {
	return Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return (
			codePoint <= 0x1f ||
			(codePoint >= 0x7f && codePoint <= 0x9f) ||
			codePoint === 0x2028 ||
			codePoint === 0x2029
		);
	});
}

export function parseNativeDisplayName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (
		!trimmed ||
		hasUnsafeDisplayNameCharacter(trimmed) ||
		Array.from(trimmed).length > DATABASE_DISPLAY_NAME_LIMIT
	) {
		return null;
	}
	return trimmed;
}

export function requireNativeDisplayName(value: unknown, label: string) {
	const parsed = parseNativeDisplayName(value);
	if (!parsed) throw new Error(`${label} is malformed`);
	return parsed;
}
