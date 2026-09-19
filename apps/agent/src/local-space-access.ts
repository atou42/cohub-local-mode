import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";

export const LOCAL_SPACE_WRITABLE_ROOTS_ENV =
	"COHUB_LOCAL_SPACE_WRITABLE_ROOTS_JSON";

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isInsideRoot(root: string, candidate: string) {
	const offset = relative(root, candidate);
	return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

export function parseLocalSpaceWritableRoots(
	raw: string | undefined,
	spaceId: string,
	homeDirectory = homedir(),
) {
	if (!raw?.trim()) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`${LOCAL_SPACE_WRITABLE_ROOTS_ENV} must be valid JSON`, {
			cause: error,
		});
	}
	if (!isRecord(parsed)) {
		throw new Error(
			`${LOCAL_SPACE_WRITABLE_ROOTS_ENV} must be an object keyed by Space id`,
		);
	}

	const home = realpathSync(resolve(homeDirectory));
	const normalized = new Map<string, string[]>();
	for (const [configuredSpaceId, value] of Object.entries(parsed)) {
		if (!configuredSpaceId.trim() || !Array.isArray(value)) {
			throw new Error(
				`${LOCAL_SPACE_WRITABLE_ROOTS_ENV} entries must map a Space id to an array`,
			);
		}
		const roots: string[] = [];
		for (const item of value) {
			if (typeof item !== "string" || !isAbsolute(item)) {
				throw new Error(
					`${LOCAL_SPACE_WRITABLE_ROOTS_ENV} roots must be absolute paths`,
				);
			}
			let root: string;
			try {
				root = realpathSync(resolve(item));
			} catch (error) {
				throw new Error(
					`${LOCAL_SPACE_WRITABLE_ROOTS_ENV} root does not exist: ${item}`,
					{ cause: error },
				);
			}
			if (!isInsideRoot(home, root)) {
				throw new Error(
					`${LOCAL_SPACE_WRITABLE_ROOTS_ENV} root is outside the local user's home directory: ${item}`,
				);
			}
			if (!roots.includes(root)) roots.push(root);
		}
		normalized.set(configuredSpaceId, roots);
	}
	return normalized.get(spaceId) ?? [];
}

export function getLocalSpaceWritableRoots(spaceId: string) {
	return parseLocalSpaceWritableRoots(
		process.env[LOCAL_SPACE_WRITABLE_ROOTS_ENV],
		spaceId,
	);
}

export function resolveGrokSandboxProfile(
	spaceId: string,
	writableRoots: readonly string[],
) {
	if (writableRoots.length === 0) return "workspace";
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(spaceId)) {
		throw new Error(`Invalid Space id for Grok sandbox profile: ${spaceId}`);
	}
	return `cohub-local-${spaceId.toLowerCase()}`;
}

export function localSpaceAccessKey(writableRoots: readonly string[]) {
	return JSON.stringify(writableRoots);
}
