import { isModelMime, isTextMime, normalizeMime } from "@cohub/protocol/fs";

const isMediaMime = (mime: string) =>
	mime.startsWith("image/") ||
	mime.startsWith("video/") ||
	mime.startsWith("audio/") ||
	mime === "application/pdf";

export function resolveReadMimeType(
	byName: string | null | undefined,
	provided: string | null | undefined,
): string | null {
	const nameMime = normalizeMime(byName);
	const providedMime = normalizeMime(provided);

	if (isTextMime(nameMime) || isModelMime(nameMime)) return nameMime;
	if (providedMime && (isTextMime(providedMime) || isMediaMime(providedMime))) {
		return providedMime;
	}
	return nameMime ?? providedMime;
}
