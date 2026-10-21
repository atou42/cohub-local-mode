import type { ContentBlock } from "@cohub/protocol/core";

export const MAX_COMPOSER_ATTACHMENTS = 14;
export const MAX_COMPOSER_TEXT_ATTACHMENT_BYTES = 200 * 1024;

const supportedImageMimeTypes = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
]);

const imageExtensions = new Set([
	"jpg",
	"jpeg",
	"png",
	"gif",
	"webp",
	"svg",
	"avif",
	"bmp",
	"ico",
	"tif",
	"tiff",
	"heic",
	"heif",
]);

const supportedTextExtensions = new Set([
	"txt",
	"md",
	"markdown",
	"mdown",
	"mkdn",
	"json",
	"jsonc",
	"yaml",
	"yml",
	"csv",
	"log",
	"toml",
	"ini",
	"env",
	"xml",
	"html",
	"htm",
	"css",
	"js",
	"mjs",
	"cjs",
	"ts",
	"tsx",
	"jsx",
	"py",
	"sh",
	"bash",
	"zsh",
	"sql",
	"graphql",
	"gql",
	"go",
	"rs",
	"java",
	"rb",
	"php",
	"c",
	"cpp",
	"h",
	"hpp",
]);

const supportedTextMimeTypes = new Set([
	"text/plain",
	"text/markdown",
	"text/csv",
	"text/html",
	"text/css",
	"text/javascript",
	"application/json",
	"application/ld+json",
	"application/xml",
	"application/yaml",
	"application/x-yaml",
	"application/javascript",
	"application/typescript",
	"application/x-typescript",
	"application/sql",
]);

function getFileExtension(name: string) {
	const lastDot = name.lastIndexOf(".");
	if (lastDot === -1) return "";
	return name.slice(lastDot + 1).toLowerCase();
}

export const COMPOSER_ATTACHMENT_ACCEPT = "";

export type ComposerAttachmentUploadStatus =
	| "ready"
	| "uploading"
	| "finalizing"
	| "failed";

export type ComposerImageAttachment = {
	kind: "image";
	id: string;
	name: string;
	mediaType: "image/webp" | "image/jpeg";
	file: File;
	previewUrl: string;
	uploadedUrl?: string;
	size: number;
	status: ComposerAttachmentUploadStatus;
	progress?: number;
};

export type ComposerTextAttachment = {
	kind: "text";
	id: string;
	name: string;
	mediaType: string;
	text: string;
	size: number;
};

export type ComposerFileAttachment = {
	kind: "file";
	id: string;
	name: string;
	relativePath: string;
	mediaType: string | null;
	file: File;
	size: number;
	status: ComposerAttachmentUploadStatus;
	progress?: number;
};

export type ComposerAttachment =
	| ComposerImageAttachment
	| ComposerTextAttachment
	| ComposerFileAttachment;

export function createComposerAttachmentId(file: File) {
	return `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isSupportedComposerImageFile(file: File) {
	return supportedImageMimeTypes.has(file.type);
}

export function isComposerImageFile(file: File) {
	return (
		file.type.startsWith("image/") ||
		imageExtensions.has(getFileExtension(file.name))
	);
}

export function isSupportedComposerAttachmentFile(file: File) {
	if (isSupportedComposerImageFile(file)) return true;
	if (supportedTextMimeTypes.has(file.type)) return true;
	return supportedTextExtensions.has(getFileExtension(file.name));
}

/** Callers keep files over {@link MAX_COMPOSER_TEXT_ATTACHMENT_BYTES} as file attachments. */
export async function readComposerTextAttachment(
	file: File,
): Promise<ComposerTextAttachment> {
	const text = await file.text();
	return {
		kind: "text",
		id: createComposerAttachmentId(file),
		name: file.name,
		mediaType: file.type || "text/plain",
		text,
		size: file.size,
	};
}

export function buildComposerTextContentBlock(
	attachment: ComposerTextAttachment,
): ContentBlock {
	return {
		type: "text",
		text: `[File: ${attachment.name}]\n${attachment.text}`,
		_meta: {
			filename: attachment.name,
			mediaType: attachment.mediaType,
			attachmentKind: "text",
			size: attachment.size,
		},
	};
}
