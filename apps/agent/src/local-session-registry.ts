import { and, asc, eq, gte, lte } from "drizzle-orm";
import {
	sessionMessages,
	sessionTurns,
	sessionTurnSegments,
	spaceSandboxes,
	spaceSessions,
} from "@cohub/db";
import type { AgentHarness } from "@cohub/protocol";
import { db } from "./db.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import {
	buildLocalSessionManifest,
	collectNativeSessionReferences,
	ensureLocalSessionRegistryRoot,
	fileExists,
	localSessionRegistryPaths,
	readExistingLocalSessionManifest,
	resolveNativeSessionArtifact,
	sanitizeLocalSessionTranscriptContent,
	sanitizeLocalSessionTranscriptMeta,
	serializeLocalSessionTranscript,
	type LocalSessionIndexEntry,
	type LocalSessionTranscriptMessage,
	writeLocalSessionIndex,
	writeLocalSessionRegistryError,
	writeLocalSessionRegistryFiles,
} from "./local-session-registry-core.js";
import {
	getAgentSessionFilePath,
	getAgentWorkspacePath,
} from "./runtime/paths.js";

type LocalSessionRow = {
	id: string;
	spaceId: string;
	agentHarness: AgentHarness;
	externalSessionId: string | null;
	title: string | null;
	status: string | null;
	createdAt: Date | null;
	updatedAt: Date | null;
};

const writeChains = new Map<string, Promise<unknown>>();

function enqueueSpaceWrite<T>(spaceId: string, operation: () => Promise<T>) {
	const previous = writeChains.get(spaceId) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(operation);
	writeChains.set(spaceId, current);
	void current.finally(() => {
		if (writeChains.get(spaceId) === current) writeChains.delete(spaceId);
	}).catch(() => undefined);
	return current;
}

function messageRecord(value: typeof sessionMessages.$inferSelect): LocalSessionTranscriptMessage {
	return {
		id: value.id,
		turnId: value.turnId,
		sequence: value.sequence,
		role: value.role,
		content: sanitizeLocalSessionTranscriptContent(value.content),
		text: value.text,
		provider: value.provider,
		model: value.model,
		stopReason: value.stopReason,
		errorMessage: value.errorMessage,
		usage: value.usage,
		meta: sanitizeLocalSessionTranscriptMeta(value.meta),
		startedAt: value.startedAt,
		completedAt: value.completedAt,
		createdAt: value.createdAt,
	};
}

async function loadLogicalSessionMessages(sessionId: string) {
	const segments = await db
		.select()
		.from(sessionTurnSegments)
		.where(eq(sessionTurnSegments.sessionId, sessionId))
		.orderBy(asc(sessionTurnSegments.ordinal));
	if (segments.length === 0) {
		const rows = await db
			.select()
			.from(sessionMessages)
			.where(eq(sessionMessages.sessionId, sessionId))
			.orderBy(asc(sessionMessages.sequence), asc(sessionMessages.createdAt));
		return rows.map(messageRecord);
	}

	const messages: LocalSessionTranscriptMessage[] = [];
	for (const segment of segments) {
		const predicates = [
			eq(sessionTurns.sessionId, segment.sourceSessionId),
			gte(sessionTurns.sequence, segment.fromSequence),
		];
		if (segment.toSequence !== null) {
			predicates.push(lte(sessionTurns.sequence, segment.toSequence));
		}
		const rows = await db
			.select({ message: sessionMessages })
			.from(sessionMessages)
			.innerJoin(sessionTurns, eq(sessionMessages.turnId, sessionTurns.id))
			.where(and(...predicates))
			.orderBy(asc(sessionTurns.sequence), asc(sessionMessages.sequence));
		messages.push(...rows.map((row) => messageRecord(row.message)));
	}
	return messages;
}

async function getLocalSessionRow(spaceId: string, sessionId: string) {
	const [row] = await db
		.select({
			id: spaceSessions.id,
			spaceId: spaceSessions.spaceId,
			agentHarness: spaceSessions.agentHarness,
			externalSessionId: spaceSessions.externalSessionId,
			title: spaceSessions.title,
			status: spaceSessions.status,
			createdAt: spaceSessions.createdAt,
			updatedAt: spaceSessions.updatedAt,
		})
		.from(spaceSessions)
		.innerJoin(
			spaceSandboxes,
			and(
				eq(spaceSandboxes.spaceId, spaceSessions.spaceId),
				eq(spaceSandboxes.provider, "local"),
			),
		)
		.where(and(eq(spaceSessions.id, sessionId), eq(spaceSessions.spaceId, spaceId)))
		.limit(1);
	if (!row) throw new Error(`Local Space session not found: ${spaceId}/${sessionId}`);
	return row;
}

async function listLocalSessionRows(spaceId: string) {
	return db
		.select({
			id: spaceSessions.id,
			spaceId: spaceSessions.spaceId,
			agentHarness: spaceSessions.agentHarness,
			externalSessionId: spaceSessions.externalSessionId,
			title: spaceSessions.title,
			status: spaceSessions.status,
			createdAt: spaceSessions.createdAt,
			updatedAt: spaceSessions.updatedAt,
		})
		.from(spaceSessions)
		.innerJoin(
			spaceSandboxes,
			and(
				eq(spaceSandboxes.spaceId, spaceSessions.spaceId),
				eq(spaceSandboxes.provider, "local"),
			),
		)
		.where(eq(spaceSessions.spaceId, spaceId))
		.orderBy(asc(spaceSessions.createdAt), asc(spaceSessions.id));
}

function buildIndexEntry(row: LocalSessionRow): LocalSessionIndexEntry {
	return {
		cohubSessionId: row.id,
		activeHarness: row.agentHarness,
		externalSessionId: row.externalSessionId,
		title: row.title,
		status: row.status,
		updatedAt: row.updatedAt?.toISOString() ?? null,
		manifestPath: `${row.id}/manifest.json`,
		transcriptPath: `${row.id}/transcript.jsonl`,
	};
}

async function refreshSpaceIndex(spaceId: string, workspacePath: string, rows?: LocalSessionRow[]) {
	const sessions = rows ?? (await listLocalSessionRows(spaceId));
	const updatedAt = sessions.reduce<string | null>((latest, session) => {
		const candidate = session.updatedAt?.toISOString() ?? null;
		return candidate && (!latest || candidate > latest) ? candidate : latest;
	}, null);
	await writeLocalSessionIndex({
		workspacePath,
		index: {
			schemaVersion: 1,
			spaceId,
			updatedAt,
			sessions: sessions.map(buildIndexEntry),
		},
	});
}

async function syncSession(input: {
	row: LocalSessionRow;
	workspacePath: string;
	refreshIndex: boolean;
}) {
	const { row, workspacePath } = input;
	const messages = await loadLogicalSessionMessages(row.id);
	const piSessionFile = getAgentSessionFilePath(row.spaceId, row.id);
	const references = collectNativeSessionReferences({
		activeHarness: row.agentHarness,
		cohubSessionId: row.id,
		externalSessionId: row.externalSessionId,
		messages,
		piFileExists: await fileExists(piSessionFile),
	});
	const checkedAt = row.updatedAt?.toISOString() ?? new Date().toISOString();
	const nativeSessions = await Promise.all(
		references.map((reference) =>
			resolveNativeSessionArtifact({
				reference,
				spaceId: row.spaceId,
				cohubSessionId: row.id,
				workspacePath,
				sessionsRoot: env.SESSIONS_DIR,
				checkedAt,
			}),
		),
	);
	const existing = await readExistingLocalSessionManifest({
		workspacePath,
		spaceId: row.spaceId,
		sessionId: row.id,
	});
	const manifest = buildLocalSessionManifest({
		spaceId: row.spaceId,
		sessionId: row.id,
		activeHarness: row.agentHarness,
		title: row.title,
		status: row.status,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		nativeSessions,
		existing,
	});
	const transcript = serializeLocalSessionTranscript({
		spaceId: row.spaceId,
		sessionId: row.id,
		activeHarness: row.agentHarness,
		externalSessionId: row.externalSessionId,
		messages,
	});
	await writeLocalSessionRegistryFiles({ workspacePath, manifest, transcript });
	if (input.refreshIndex) await refreshSpaceIndex(row.spaceId, workspacePath);
	return localSessionRegistryPaths({ workspacePath, sessionId: row.id });
}

export async function ensureLocalSessionRegistryForSpace(spaceId: string) {
	if (env.COHUB_NODE_ORIGIN !== "local") return null;
	return ensureLocalSessionRegistryRoot(getAgentWorkspacePath(spaceId));
}

export async function syncLocalSessionRegistry(input: { spaceId: string; sessionId: string }) {
	if (env.COHUB_NODE_ORIGIN !== "local") return null;
	return enqueueSpaceWrite(input.spaceId, async () => {
		const row = await getLocalSessionRow(input.spaceId, input.sessionId);
		return syncSession({
			row,
			workspacePath: getAgentWorkspacePath(input.spaceId),
			refreshIndex: true,
		});
	});
}

export async function recordLocalSessionRegistryFailure(input: {
	spaceId: string;
	sessionId: string;
	error: unknown;
}) {
	if (env.COHUB_NODE_ORIGIN !== "local") return null;
	return writeLocalSessionRegistryError({
		workspacePath: getAgentWorkspacePath(input.spaceId),
		sessionId: input.sessionId,
		error: input.error,
	});
}

export async function backfillLocalSessionRegistries() {
	if (env.COHUB_NODE_ORIGIN !== "local") return { spaces: 0, sessions: 0 };
	const rows = await db
		.select({
			id: spaceSessions.id,
			spaceId: spaceSessions.spaceId,
			agentHarness: spaceSessions.agentHarness,
			externalSessionId: spaceSessions.externalSessionId,
			title: spaceSessions.title,
			status: spaceSessions.status,
			createdAt: spaceSessions.createdAt,
			updatedAt: spaceSessions.updatedAt,
		})
		.from(spaceSessions)
		.innerJoin(
			spaceSandboxes,
			and(
				eq(spaceSandboxes.spaceId, spaceSessions.spaceId),
				eq(spaceSandboxes.provider, "local"),
			),
		)
		.orderBy(asc(spaceSessions.spaceId), asc(spaceSessions.createdAt), asc(spaceSessions.id));
	const grouped = new Map<string, LocalSessionRow[]>();
	for (const row of rows) {
		const sessions = grouped.get(row.spaceId) ?? [];
		sessions.push(row);
		grouped.set(row.spaceId, sessions);
	}
	const failures: unknown[] = [];
	await Promise.all([...grouped].map(([spaceId, sessions]) =>
		enqueueSpaceWrite(spaceId, async () => {
			const workspacePath = getAgentWorkspacePath(spaceId);
			let cursor = 0;
			const workerCount = Math.min(6, sessions.length);
			await Promise.all(Array.from({ length: workerCount }, async () => {
				for (;;) {
					const row = sessions[cursor];
					cursor += 1;
					if (!row) break;
					try {
						await syncSession({ row, workspacePath, refreshIndex: false });
					} catch (error) {
						failures.push(error);
						await recordLocalSessionRegistryFailure({
							spaceId,
							sessionId: row.id,
							error,
						}).catch((recordError) => failures.push(recordError));
					}
				}
			}));
			try {
				await refreshSpaceIndex(spaceId, workspacePath, sessions);
			} catch (error) {
				failures.push(error);
			}
		}),
	));
	if (failures.length > 0) {
		throw new AggregateError(failures, "Local session registry backfill failed");
	}
	logger.info("[LocalSessionRegistry] backfill complete", {
		spaces: grouped.size,
		sessions: rows.length,
	});
	return { spaces: grouped.size, sessions: rows.length };
}
