import { randomUUID } from "node:crypto";
import {
	access,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { AgentHarness } from "@cohub/protocol";
import type { ContentBlock, Usage } from "@cohub/protocol/core";

export const LOCAL_SESSION_REGISTRY_RELATIVE_DIR = ".cohub/local-sessions";
export const LOCAL_SESSION_REGISTRY_ENV = "COHUB_LOCAL_SESSIONS_DIR";
export const LOCAL_SESSION_MANIFEST_ENV = "COHUB_LOCAL_SESSION_MANIFEST";
export const LOCAL_SESSION_TRANSCRIPT_ENV = "COHUB_LOCAL_SESSION_TRANSCRIPT";

const REGISTRY_SCHEMA_VERSION = 1;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSCRIPT_META_KEYS = [
	"agentHarness",
	"externalSessionId",
	"messageKind",
	"turnId",
	"messageOrdinal",
	"requestedThinkingLevel",
	"effectiveThinkingLevel",
	"requestedServiceTier",
	"effectiveServiceTier",
	"runtimeFailed",
	"forkCheckpoint",
] as const;

export type LocalSessionTranscriptMessage = {
	id: string;
	turnId: string | null;
	sequence: number;
	role: string;
	content: ContentBlock[];
	text: string | null;
	provider: string | null;
	model: string | null;
	stopReason: string | null;
	errorMessage: string | null;
	usage: Usage | null;
	meta: Record<string, unknown> | null;
	startedAt: Date | null;
	completedAt: Date | null;
	createdAt: Date | null;
};

export type LocalNativeSessionReference = {
	harness: AgentHarness;
	externalSessionId: string;
	sources: string[];
};

export type LocalNativeSessionArtifact = LocalNativeSessionReference & {
	path: string;
	format:
		| "pi_jsonl"
		| "codex_rollout_jsonl"
		| "grok_session_directory"
		| "cursor_acp_directory";
	status: "available" | "missing";
	checkedAt: string;
};

export type LocalSessionManifest = {
	schemaVersion: 1;
	spaceId: string;
	cohubSessionId: string;
	activeHarness: AgentHarness;
	title: string | null;
	status: string | null;
	createdAt: string | null;
	updatedAt: string | null;
	transcriptPath: string;
	nativeSessions: LocalNativeSessionArtifact[];
};

export type LocalSessionIndexEntry = {
	cohubSessionId: string;
	activeHarness: AgentHarness;
	externalSessionId: string | null;
	title: string | null;
	status: string | null;
	updatedAt: string | null;
	manifestPath: string;
	transcriptPath: string;
};

export type LocalSessionIndex = {
	schemaVersion: 1;
	spaceId: string;
	updatedAt: string | null;
	sessions: LocalSessionIndexEntry[];
};

function assertUuid(label: string, value: string) {
	if (!UUID_PATTERN.test(value)) throw new Error(`${label} must be a UUID`);
}

function iso(value: Date | null | undefined) {
	return value ? value.toISOString() : null;
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function sanitizeLocalSessionTranscriptMeta(value: unknown) {
	const source = record(value);
	if (!source) return null;
	const safe = Object.fromEntries(
		TRANSCRIPT_META_KEYS.flatMap((key) =>
			source[key] === undefined ? [] : [[key, source[key]]],
		),
	);
	return Object.keys(safe).length > 0 ? safe : null;
}

export function sanitizeLocalSessionTranscriptContent(content: ContentBlock[]) {
	return content.map((block) => {
		const meta = record(block._meta);
		const runtimeEvent = record(meta?.runtimeEvent);
		if (!meta || !runtimeEvent || runtimeEvent.raw === undefined) return block;
		const { raw: _raw, ...safeRuntimeEvent } = runtimeEvent;
		return {
			...block,
			_meta: {
				...meta,
				runtimeEvent: safeRuntimeEvent,
			},
		} as ContentBlock;
	});
}

function nativeSessionKey(value: Pick<LocalNativeSessionReference, "harness" | "externalSessionId">) {
	return `${value.harness}\0${value.externalSessionId}`;
}

function isAgentHarness(value: unknown): value is AgentHarness {
	return value === "pi" || value === "codex" || value === "grok_build" || value === "cursor";
}

function expectedNativeFormat(harness: AgentHarness): LocalNativeSessionArtifact["format"] {
	if (harness === "pi") return "pi_jsonl";
	if (harness === "codex") return "codex_rollout_jsonl";
	if (harness === "grok_build") return "grok_session_directory";
	return "cursor_acp_directory";
}

export function localSessionRegistryRoot(workspacePath: string) {
	return join(workspacePath, LOCAL_SESSION_REGISTRY_RELATIVE_DIR);
}

export function localSessionRegistryPaths(input: {
	workspacePath: string;
	sessionId: string;
}) {
	assertUuid("sessionId", input.sessionId);
	const root = localSessionRegistryRoot(input.workspacePath);
	const sessionRoot = join(root, input.sessionId);
	return {
		root,
		index: join(root, "index.json"),
		sessionRoot,
		manifest: join(sessionRoot, "manifest.json"),
		transcript: join(sessionRoot, "transcript.jsonl"),
		error: join(sessionRoot, "sync-error.json"),
	};
}

async function pathStatus(path: string, expected: "file" | "directory") {
	try {
		const info = await stat(path);
		return expected === "file" ? info.isFile() : info.isDirectory();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

const codexRolloutIndexes = new Map<string, Map<string, string>>();
const codexRolloutIndexPromises = new Map<string, Promise<Map<string, string>>>();

function codexIdFromFileName(name: string) {
	const match = name.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
	return match?.[1] ?? null;
}

async function indexCodexRollouts(root: string) {
	const existing = codexRolloutIndexes.get(root);
	if (existing) return existing;
	const pendingIndex = codexRolloutIndexPromises.get(root);
	if (pendingIndex) return pendingIndex;
	const operation = (async () => {
		const index = new Map<string, string>();
		const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
		while (pending.length > 0) {
			const current = pending.pop();
			if (!current) break;
			let entries: Dirent<string>[];
			try {
				entries = await readdir(current.path, { withFileTypes: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			for (const entry of entries) {
				const path = join(current.path, entry.name);
				if (entry.isFile()) {
					const id = codexIdFromFileName(entry.name);
					if (id) index.set(id, path);
				} else if (entry.isDirectory() && current.depth < 5) {
					pending.push({ path, depth: current.depth + 1 });
				}
			}
		}
		codexRolloutIndexes.set(root, index);
		return index;
	})();
	codexRolloutIndexPromises.set(root, operation);
	try {
		return await operation;
	} finally {
		codexRolloutIndexPromises.delete(root);
	}
}

function nearbyCodexDatePaths(root: string, checkedAt: string) {
	const timestamp = new Date(checkedAt);
	if (Number.isNaN(timestamp.getTime())) return [];
	return [-1, 0, 1].map((offset) => {
		const date = new Date(timestamp);
		date.setUTCDate(date.getUTCDate() + offset);
		return join(
			root,
			String(date.getUTCFullYear()),
			String(date.getUTCMonth() + 1).padStart(2, "0"),
			String(date.getUTCDate()).padStart(2, "0"),
		);
	});
}

async function findCodexRollout(root: string, externalSessionId: string, checkedAt: string) {
	const cached = codexRolloutIndexes.get(root)?.get(externalSessionId);
	if (cached) return cached;
	const suffix = `-${externalSessionId}.jsonl`;
	for (const directory of nearbyCodexDatePaths(root, checkedAt)) {
		let entries: Dirent<string>[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		const match = entries.find((entry) => entry.isFile() && entry.name.endsWith(suffix));
		if (match) {
			const path = join(directory, match.name);
			const index = codexRolloutIndexes.get(root) ?? new Map<string, string>();
			index.set(externalSessionId, path);
			codexRolloutIndexes.set(root, index);
			return path;
		}
	}
	const indexed = await indexCodexRollouts(root);
	return indexed.get(externalSessionId) ?? null;
}

export async function resolveNativeSessionArtifact(input: {
	reference: LocalNativeSessionReference;
	spaceId: string;
	cohubSessionId: string;
	workspacePath: string;
	sessionsRoot: string;
	homeDirectory?: string;
	checkedAt: string;
}): Promise<LocalNativeSessionArtifact> {
	assertUuid("spaceId", input.spaceId);
	assertUuid("cohubSessionId", input.cohubSessionId);
	const home = input.homeDirectory ?? homedir();
	const { harness, externalSessionId } = input.reference;
	if (!externalSessionId.trim()) throw new Error("native session id cannot be empty");

	if (harness === "pi") {
		const path = join(
			input.sessionsRoot,
			"spaces",
			input.spaceId,
			`${input.cohubSessionId}.jsonl`,
		);
		return {
			...input.reference,
			path,
			format: "pi_jsonl",
			status: (await pathStatus(path, "file")) ? "available" : "missing",
			checkedAt: input.checkedAt,
		};
	}

	if (harness === "codex") {
		const root = join(home, ".codex", "sessions");
		const found = await findCodexRollout(root, externalSessionId, input.checkedAt);
		return {
			...input.reference,
			path: found ?? join(root, `**/rollout-*-${externalSessionId}.jsonl`),
			format: "codex_rollout_jsonl",
			status: found ? "available" : "missing",
			checkedAt: input.checkedAt,
		};
	}

	if (harness === "grok_build") {
		const path = join(
			home,
			".grok",
			"sessions",
			encodeURIComponent(input.workspacePath),
			externalSessionId,
		);
		return {
			...input.reference,
			path,
			format: "grok_session_directory",
			status: (await pathStatus(path, "directory")) ? "available" : "missing",
			checkedAt: input.checkedAt,
		};
	}

	const path = join(home, ".cursor", "acp-sessions", externalSessionId);
	return {
		...input.reference,
		path,
		format: "cursor_acp_directory",
		status: (await pathStatus(path, "directory")) ? "available" : "missing",
		checkedAt: input.checkedAt,
	};
}

export function collectNativeSessionReferences(input: {
	activeHarness: AgentHarness;
	cohubSessionId: string;
	externalSessionId: string | null;
	messages: LocalSessionTranscriptMessage[];
	piFileExists: boolean;
}) {
	const references = new Map<string, LocalNativeSessionReference>();
	const add = (harness: AgentHarness, externalSessionId: string, source: string) => {
		const normalized = externalSessionId.trim();
		if (!normalized) return;
		const key = nativeSessionKey({ harness, externalSessionId: normalized });
		const existing = references.get(key);
		if (existing) {
			if (!existing.sources.includes(source)) existing.sources.push(source);
			return;
		}
		references.set(key, { harness, externalSessionId: normalized, sources: [source] });
	};

	if (input.piFileExists || input.activeHarness === "pi") {
		add("pi", input.cohubSessionId, input.piFileExists ? "pi_file" : "active_session");
	}
	if (input.externalSessionId) {
		add(input.activeHarness, input.externalSessionId, "active_session");
	}
	for (const message of input.messages) {
		const meta = record(message.meta);
		const harness = meta?.agentHarness;
		const externalSessionId = meta?.externalSessionId;
		if (
			(harness === "codex" || harness === "grok_build" || harness === "cursor") &&
			typeof externalSessionId === "string"
		) {
			add(harness, externalSessionId, "message_metadata");
		}
	}
	return [...references.values()].sort((left, right) =>
		nativeSessionKey(left).localeCompare(nativeSessionKey(right)),
	);
}

export function buildLocalSessionManifest(input: {
	spaceId: string;
	sessionId: string;
	activeHarness: AgentHarness;
	title: string | null;
	status: string | null;
	createdAt: Date | null;
	updatedAt: Date | null;
	nativeSessions: LocalNativeSessionArtifact[];
	existing?: LocalSessionManifest | null;
}) {
	assertUuid("spaceId", input.spaceId);
	assertUuid("sessionId", input.sessionId);
	const merged = new Map<string, LocalNativeSessionArtifact>();
	for (const item of input.existing?.nativeSessions ?? []) {
		merged.set(nativeSessionKey(item), item);
	}
	for (const item of input.nativeSessions) {
		const key = nativeSessionKey(item);
		const previous = merged.get(key);
		merged.set(key, {
			...item,
			sources: [...new Set([...(previous?.sources ?? []), ...item.sources])].sort(),
		});
	}
	return {
		schemaVersion: REGISTRY_SCHEMA_VERSION,
		spaceId: input.spaceId,
		cohubSessionId: input.sessionId,
		activeHarness: input.activeHarness,
		title: input.title,
		status: input.status,
		createdAt: iso(input.createdAt),
		updatedAt: iso(input.updatedAt),
		transcriptPath: `${input.sessionId}/transcript.jsonl`,
		nativeSessions: [...merged.values()].sort((left, right) =>
			nativeSessionKey(left).localeCompare(nativeSessionKey(right)),
		),
	} satisfies LocalSessionManifest;
}

export function serializeLocalSessionTranscript(input: {
	spaceId: string;
	sessionId: string;
	activeHarness: AgentHarness;
	externalSessionId: string | null;
	messages: LocalSessionTranscriptMessage[];
}) {
	assertUuid("spaceId", input.spaceId);
	assertUuid("sessionId", input.sessionId);
	const lines = [
		{
			type: "session",
			schemaVersion: REGISTRY_SCHEMA_VERSION,
			spaceId: input.spaceId,
			cohubSessionId: input.sessionId,
			activeHarness: input.activeHarness,
			externalSessionId: input.externalSessionId,
		},
		...input.messages.map((message) => ({
			type: "message",
			id: message.id,
			turnId: message.turnId,
			sequence: message.sequence,
			role: message.role,
			content: message.content,
			text: message.text,
			provider: message.provider,
			model: message.model,
			stopReason: message.stopReason,
			errorMessage: message.errorMessage,
			usage: message.usage,
			meta: message.meta,
			startedAt: iso(message.startedAt),
			completedAt: iso(message.completedAt),
			createdAt: iso(message.createdAt),
		})),
	];
	return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

async function readJsonIfPresent<T>(path: string): Promise<T | null> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	try {
		return JSON.parse(raw) as T;
	} catch (error) {
		throw new Error(`Refusing to overwrite malformed local session registry file: ${path}`, {
			cause: error,
		});
	}
}

async function atomicWriteIfChanged(path: string, content: string) {
	try {
		if ((await readFile(path, "utf8")) === content) return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
	let handle: FileHandle | undefined;
	try {
		handle = await open(temporary, "wx", 0o600);
		await handle.writeFile(content, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, path);
		return true;
	} finally {
		await handle?.close().catch(() => undefined);
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

export async function ensureLocalSessionRegistryRoot(workspacePath: string) {
	const root = localSessionRegistryRoot(workspacePath);
	await mkdir(root, { recursive: true });
	await atomicWriteIfChanged(join(root, ".gitignore"), "*\n");
	return root;
}

function assertExistingManifest(
	value: unknown,
	input: { spaceId: string; sessionId: string },
): asserts value is LocalSessionManifest {
	const manifest = record(value);
	if (
		manifest?.schemaVersion !== REGISTRY_SCHEMA_VERSION ||
		manifest.spaceId !== input.spaceId ||
		manifest.cohubSessionId !== input.sessionId ||
		!isAgentHarness(manifest.activeHarness) ||
		manifest.transcriptPath !== `${input.sessionId}/transcript.jsonl` ||
		!Array.isArray(manifest.nativeSessions)
	) {
		throw new Error(`Local session manifest does not match ${input.spaceId}/${input.sessionId}`);
	}
	for (const candidate of manifest.nativeSessions) {
		const artifact = record(candidate);
		if (
			!artifact ||
			!isAgentHarness(artifact.harness) ||
			typeof artifact.externalSessionId !== "string" ||
			!artifact.externalSessionId.trim() ||
			!Array.isArray(artifact.sources) ||
			artifact.sources.some((source) => typeof source !== "string" || !source.trim()) ||
			typeof artifact.path !== "string" ||
			!isAbsolute(artifact.path) ||
			artifact.format !== expectedNativeFormat(artifact.harness) ||
			(artifact.status !== "available" && artifact.status !== "missing") ||
			typeof artifact.checkedAt !== "string"
		) {
			throw new Error(`Local session manifest contains an invalid native mapping: ${input.sessionId}`);
		}
	}
}

export async function readExistingLocalSessionManifest(input: {
	workspacePath: string;
	spaceId: string;
	sessionId: string;
}): Promise<LocalSessionManifest | null> {
	const paths = localSessionRegistryPaths(input);
	const existing = await readJsonIfPresent<unknown>(paths.manifest);
	if (existing !== null) assertExistingManifest(existing, input);
	return existing;
}

export async function writeLocalSessionRegistryFiles(input: {
	workspacePath: string;
	manifest: LocalSessionManifest;
	transcript: string;
}) {
	const paths = localSessionRegistryPaths({
		workspacePath: input.workspacePath,
		sessionId: input.manifest.cohubSessionId,
	});
	await ensureLocalSessionRegistryRoot(input.workspacePath);
	const existing = await readJsonIfPresent<unknown>(paths.manifest);
	if (existing) {
		assertExistingManifest(existing, {
			spaceId: input.manifest.spaceId,
			sessionId: input.manifest.cohubSessionId,
		});
	}
	await atomicWriteIfChanged(paths.transcript, input.transcript);
	await atomicWriteIfChanged(paths.manifest, `${JSON.stringify(input.manifest, null, 2)}\n`);
	await rm(paths.error, { force: true });
	return paths;
}

export async function writeLocalSessionIndex(input: {
	workspacePath: string;
	index: LocalSessionIndex;
}) {
	assertUuid("spaceId", input.index.spaceId);
	const root = await ensureLocalSessionRegistryRoot(input.workspacePath);
	const path = join(root, "index.json");
	const existing = await readJsonIfPresent<unknown>(path);
	if (existing) {
		const index = record(existing);
		if (
			index?.schemaVersion !== REGISTRY_SCHEMA_VERSION ||
			index.spaceId !== input.index.spaceId ||
			!Array.isArray(index.sessions)
		) {
			throw new Error(`Local session index does not match Space ${input.index.spaceId}`);
		}
		for (const candidate of index.sessions) {
			const session = record(candidate);
			const id = typeof session?.cohubSessionId === "string" ? session.cohubSessionId : "";
			if (
				!UUID_PATTERN.test(id) ||
				!isAgentHarness(session?.activeHarness) ||
				session?.manifestPath !== `${id}/manifest.json` ||
				session?.transcriptPath !== `${id}/transcript.jsonl`
			) {
				throw new Error(`Local session index contains an invalid mapping for Space ${input.index.spaceId}`);
			}
		}
	}
	await atomicWriteIfChanged(path, `${JSON.stringify(input.index, null, 2)}\n`);
	return path;
}

export async function writeLocalSessionRegistryError(input: {
	workspacePath: string;
	sessionId: string;
	error: unknown;
	at?: Date;
}) {
	const paths = localSessionRegistryPaths(input);
	await ensureLocalSessionRegistryRoot(input.workspacePath);
	const error = input.error instanceof Error
		? { name: input.error.name, message: input.error.message }
		: { name: "Error", message: String(input.error) };
	await atomicWriteIfChanged(
		paths.error,
		`${JSON.stringify({ schemaVersion: REGISTRY_SCHEMA_VERSION, sessionId: input.sessionId, at: (input.at ?? new Date()).toISOString(), error }, null, 2)}\n`,
	);
	return paths.error;
}

export async function fileExists(path: string) {
	try {
		await access(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
