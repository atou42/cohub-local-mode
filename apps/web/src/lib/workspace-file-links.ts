export type WorkspaceFilePosition = {
	line: number;
	column?: number;
};

export type WorkspaceFileLinkTarget = {
	path: string;
	position?: WorkspaceFilePosition;
};

export type OpenWorkspaceFileTarget = string | WorkspaceFileLinkTarget;

export type NormalizeWorkspaceFileLinkOptions = {
	/** Current workspace-relative Markdown file path. Used for relative links. */
	basePath?: string | null;
};

const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
function stripQueryAndHash(value: string) {
	const queryIndex = value.indexOf("?");
	const hashIndex = value.indexOf("#");
	const cutIndex = [queryIndex, hashIndex]
		.filter((index) => index >= 0)
		.sort((a, b) => a - b)[0];
	return cutIndex === undefined ? value : value.slice(0, cutIndex);
}

function safeDecodeUri(value: string) {
	if (/%(?:2f|5c)/i.test(value)) return null;
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

function extractLinePosition(value: string) {
	const match = value.match(/:(\d+)(?::(\d+))?$/);
	if (!match) return { path: value };
	const line = Number(match[1]);
	const column = match[2] ? Number(match[2]) : undefined;
	return {
		path: value.slice(0, match.index),
		position:
			line > 0
				? {
						line,
						...(column && column > 0 ? { column } : {}),
					}
				: undefined,
	};
}

function dirname(path: string) {
	const normalized = normalizeWorkspacePath(path);
	if (!normalized?.includes("/")) return "";
	return normalized.slice(0, normalized.lastIndexOf("/"));
}

function hasControlCharacter(value: string) {
	return Array.from(value).some((char) => {
		const code = char.charCodeAt(0);
		return code <= 0x1f || code === 0x7f;
	});
}

function normalizeWorkspacePath(path: string) {
	if (!path || path.includes("\\") || hasControlCharacter(path)) return null;
	const parts: string[] = [];
	for (const segment of path.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (parts.length === 0) return null;
			parts.pop();
			continue;
		}
		parts.push(segment);
	}
	return parts.length > 0 ? parts.join("/") : null;
}

/**
 * Converts Markdown hrefs that refer to files inside /workspace into the
 * workspace-relative path used by the file tree and preview panel.
 */
export function normalizeWorkspaceFileLinkTarget(
	href: string,
	options: NormalizeWorkspaceFileLinkOptions = {},
): WorkspaceFileLinkTarget | null {
	const raw = href.trim();
	if (!raw || raw.startsWith("#")) return null;
	if (raw.startsWith("//") || SCHEME_PATTERN.test(raw)) return null;

	const withoutQuery = stripQueryAndHash(raw).trim();
	if (!withoutQuery) return null;

	// Encoded punctuation belongs to the filename, not a URL or line suffix.
	const { path: encodedPath, position } = extractLinePosition(withoutQuery);
	const pathWithPosition = safeDecodeUri(encodedPath);
	if (!pathWithPosition) return null;
	if (pathWithPosition.startsWith("//")) return null;
	if (pathWithPosition.includes("\\") || hasControlCharacter(pathWithPosition))
		return null;
	if (pathWithPosition === "/workspace" || pathWithPosition === "workspace")
		return null;

	if (pathWithPosition.startsWith("/")) {
		if (!pathWithPosition.startsWith("/workspace/")) return null;
		const path = normalizeWorkspacePath(
			pathWithPosition.slice("/workspace/".length),
		);
		return path ? { path, position } : null;
	}

	if (pathWithPosition.startsWith("workspace/")) {
		const path = normalizeWorkspacePath(
			pathWithPosition.slice("workspace/".length),
		);
		return path ? { path, position } : null;
	}

	const baseDir = options.basePath ? dirname(options.basePath) : "";
	const path = normalizeWorkspacePath(
		baseDir ? `${baseDir}/${pathWithPosition}` : pathWithPosition,
	);
	return path ? { path, position } : null;
}

export function normalizeWorkspaceFileLink(
	href: string,
	options: NormalizeWorkspaceFileLinkOptions = {},
) {
	return normalizeWorkspaceFileLinkTarget(href, options)?.path ?? null;
}
