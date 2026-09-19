import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildLocalSessionManifest,
	collectNativeSessionReferences,
	ensureLocalSessionRegistryRoot,
	localSessionRegistryPaths,
	resolveNativeSessionArtifact,
	sanitizeLocalSessionTranscriptContent,
	sanitizeLocalSessionTranscriptMeta,
	serializeLocalSessionTranscript,
	type LocalSessionTranscriptMessage,
	writeLocalSessionIndex,
	writeLocalSessionRegistryFiles,
} from "../local-session-registry-core.js";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const CODEX_ID = "01a05c56-57d4-78f2-83c6-0369ee66add7";
const GROK_ID = "33333333-3333-4333-8333-333333333333";
const CURSOR_ID = "44444444-4444-4444-8444-444444444444";

function transcriptMessages(): LocalSessionTranscriptMessage[] {
	return [
		{
			id: "55555555-5555-4555-8555-555555555555",
			turnId: "66666666-6666-4666-8666-666666666666",
			sequence: 1,
			role: "user",
			content: [{ type: "text", text: "Inspect the other local session." }],
			text: "Inspect the other local session.",
			provider: null,
			model: null,
			stopReason: null,
			errorMessage: null,
			usage: null,
			meta: null,
			startedAt: new Date("2026-09-01T00:00:00.000Z"),
			completedAt: new Date("2026-09-01T00:00:01.000Z"),
			createdAt: new Date("2026-09-01T00:00:00.000Z"),
		},
		{
			id: "77777777-7777-4777-8777-777777777777",
			turnId: "66666666-6666-4666-8666-666666666666",
			sequence: 2,
			role: "assistant",
			content: [{ type: "text", text: "Mapped." }],
			text: "Mapped.",
			provider: "codex",
			model: "gpt-5.6-sol",
			stopReason: "stop",
			errorMessage: null,
			usage: null,
			meta: { agentHarness: "codex", externalSessionId: CODEX_ID },
			startedAt: new Date("2026-09-01T00:00:01.000Z"),
			completedAt: new Date("2026-09-01T00:00:02.000Z"),
			createdAt: new Date("2026-09-01T00:00:01.000Z"),
		},
		{
			id: "88888888-8888-4888-8888-888888888888",
			turnId: "99999999-9999-4999-8999-999999999999",
			sequence: 3,
			role: "assistant",
			content: [{ type: "text", text: "Historical Grok message." }],
			text: "Historical Grok message.",
			provider: "grok_build",
			model: "grok-4.6",
			stopReason: "stop",
			errorMessage: null,
			usage: null,
			meta: { agentHarness: "grok_build", externalSessionId: GROK_ID },
			startedAt: null,
			completedAt: null,
			createdAt: new Date("2026-09-01T00:00:03.000Z"),
		},
	];
}

test("registry maps every native harness without moving its files", async () => {
	const root = await mkdtemp(join(tmpdir(), "cohub-local-session-registry-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	const sessionsRoot = join(root, "sessions");
	const piFile = join(sessionsRoot, "spaces", SPACE_ID, `${SESSION_ID}.jsonl`);
	const codexFile = join(
		home,
		".codex",
		"sessions",
		"2026",
		"09",
		"01",
		`rollout-2026-09-01T00-00-00-${CODEX_ID}.jsonl`,
	);
	const grokDir = join(home, ".grok", "sessions", encodeURIComponent(workspace), GROK_ID);
	const cursorDir = join(home, ".cursor", "acp-sessions", CURSOR_ID);
	await Promise.all([
		mkdir(join(piFile, ".."), { recursive: true }),
		mkdir(join(codexFile, ".."), { recursive: true }),
		mkdir(grokDir, { recursive: true }),
		mkdir(cursorDir, { recursive: true }),
	]);
	await Promise.all([writeFile(piFile, "{}\n"), writeFile(codexFile, "{}\n")]);

	const messages = transcriptMessages();
	const historicalMessage = messages[2];
	assert.ok(historicalMessage);
	messages.push({
		...historicalMessage,
		id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		sequence: 4,
		meta: { agentHarness: "cursor", externalSessionId: CURSOR_ID },
	});
	const references = collectNativeSessionReferences({
		activeHarness: "cursor",
		cohubSessionId: SESSION_ID,
		externalSessionId: CURSOR_ID,
		messages,
		piFileExists: true,
	});
	assert.deepEqual(
		references.map((item) => item.harness),
		["codex", "cursor", "grok_build", "pi"],
	);

	const artifacts = await Promise.all(
		references.map((reference) =>
			resolveNativeSessionArtifact({
				reference,
				spaceId: SPACE_ID,
				cohubSessionId: SESSION_ID,
				workspacePath: workspace,
				sessionsRoot,
				homeDirectory: home,
				checkedAt: "2026-09-01T00:00:04.000Z",
			}),
		),
	);
	assert.equal(artifacts.every((artifact) => artifact.status === "available"), true);
	assert.equal(artifacts.find((artifact) => artifact.harness === "pi")?.path, piFile);
	assert.equal(artifacts.find((artifact) => artifact.harness === "codex")?.path, codexFile);
	assert.equal(artifacts.find((artifact) => artifact.harness === "grok_build")?.path, grokDir);
	assert.equal(artifacts.find((artifact) => artifact.harness === "cursor")?.path, cursorDir);
});

test("registry writes a Git-ignored stable index, manifest, and normalized transcript", async () => {
	const root = await mkdtemp(join(tmpdir(), "cohub-local-session-write-"));
	const workspace = join(root, "workspace");
	const messages = transcriptMessages();
	const manifest = buildLocalSessionManifest({
		spaceId: SPACE_ID,
		sessionId: SESSION_ID,
		activeHarness: "codex",
		title: "Mapped session",
		status: "active",
		createdAt: new Date("2026-09-01T00:00:00.000Z"),
		updatedAt: new Date("2026-09-01T00:00:04.000Z"),
		nativeSessions: [],
	});
	const transcript = serializeLocalSessionTranscript({
		spaceId: SPACE_ID,
		sessionId: SESSION_ID,
		activeHarness: "codex",
		externalSessionId: CODEX_ID,
		messages,
	});
	await writeLocalSessionRegistryFiles({ workspacePath: workspace, manifest, transcript });
	await writeLocalSessionIndex({
		workspacePath: workspace,
		index: {
			schemaVersion: 1,
			spaceId: SPACE_ID,
			updatedAt: "2026-09-01T00:00:04.000Z",
			sessions: [{
				cohubSessionId: SESSION_ID,
				activeHarness: "codex",
				externalSessionId: CODEX_ID,
				title: "Mapped session",
				status: "active",
				updatedAt: "2026-09-01T00:00:04.000Z",
				manifestPath: `${SESSION_ID}/manifest.json`,
				transcriptPath: `${SESSION_ID}/transcript.jsonl`,
			}],
		},
	});

	const paths = localSessionRegistryPaths({ workspacePath: workspace, sessionId: SESSION_ID });
	assert.equal(await readFile(join(paths.root, ".gitignore"), "utf8"), "*\n");
	assert.deepEqual(JSON.parse(await readFile(paths.manifest, "utf8")), manifest);
	assert.equal((await readFile(paths.transcript, "utf8")).split("\n").filter(Boolean).length, 4);
	assert.equal(JSON.parse(await readFile(paths.index, "utf8")).sessions[0].cohubSessionId, SESSION_ID);
});

test("registry preserves malformed evidence and exposes missing native artifacts", async () => {
	const root = await mkdtemp(join(tmpdir(), "cohub-local-session-failure-"));
	const workspace = join(root, "workspace");
	const paths = localSessionRegistryPaths({ workspacePath: workspace, sessionId: SESSION_ID });
	await ensureLocalSessionRegistryRoot(workspace);
	await mkdir(paths.sessionRoot, { recursive: true });
	await writeFile(paths.manifest, "{broken", "utf8");
	const manifest = buildLocalSessionManifest({
		spaceId: SPACE_ID,
		sessionId: SESSION_ID,
		activeHarness: "cursor",
		title: null,
		status: "active",
		createdAt: null,
		updatedAt: null,
		nativeSessions: [],
	});
	await assert.rejects(
		writeLocalSessionRegistryFiles({ workspacePath: workspace, manifest, transcript: "{}\n" }),
		/Refusing to overwrite malformed/,
	);
	assert.equal(await readFile(paths.manifest, "utf8"), "{broken");
	const structuredWorkspace = join(root, "structured-workspace");
	const structuredPaths = localSessionRegistryPaths({
		workspacePath: structuredWorkspace,
		sessionId: SESSION_ID,
	});
	await ensureLocalSessionRegistryRoot(structuredWorkspace);
	await mkdir(structuredPaths.sessionRoot, { recursive: true });
	const invalidMapping = {
		...manifest,
		nativeSessions: [{
			harness: "cursor",
			externalSessionId: CURSOR_ID,
			sources: ["active_session"],
			path: "../../outside",
			format: "cursor_acp_directory",
			status: "available",
			checkedAt: "2026-09-01T00:00:00.000Z",
		}],
	};
	await writeFile(structuredPaths.manifest, JSON.stringify(invalidMapping), "utf8");
	await assert.rejects(
		writeLocalSessionRegistryFiles({
			workspacePath: structuredWorkspace,
			manifest,
			transcript: "{}\n",
		}),
		/invalid native mapping/,
	);
	assert.deepEqual(JSON.parse(await readFile(structuredPaths.manifest, "utf8")), invalidMapping);

	const missing = await resolveNativeSessionArtifact({
		reference: { harness: "cursor", externalSessionId: CURSOR_ID, sources: ["active_session"] },
		spaceId: SPACE_ID,
		cohubSessionId: SESSION_ID,
		workspacePath: workspace,
		sessionsRoot: join(root, "sessions"),
		homeDirectory: join(root, "home"),
		checkedAt: "2026-09-01T00:00:00.000Z",
	});
	assert.equal(missing.status, "missing");
	assert.throws(
		() => localSessionRegistryPaths({ workspacePath: workspace, sessionId: "../../escape" }),
		/must be a UUID/,
	);
});

test("shared transcript metadata excludes prompt environment and authorization context", () => {
	assert.deepEqual(
		sanitizeLocalSessionTranscriptMeta({
			agentHarness: "codex",
			externalSessionId: CODEX_ID,
			effectiveThinkingLevel: "low",
			env: { PRIVATE_TOKEN: "must-not-leak" },
			context: { auth: { token: "must-not-leak" } },
			actorUserId: "private-user",
		}),
		{
			agentHarness: "codex",
			externalSessionId: CODEX_ID,
			effectiveThinkingLevel: "low",
		},
	);
	assert.deepEqual(
		sanitizeLocalSessionTranscriptContent([{
			type: "system_note",
			text: "Runtime ready",
			note_type: "info",
			_meta: {
				streamIndex: 1,
				runtimeEvent: {
					kind: "status",
					eventType: "runtime.ready",
					raw: { env: { PRIVATE_TOKEN: "must-not-leak" } },
				},
			},
		}]),
		[{
			type: "system_note",
			text: "Runtime ready",
			note_type: "info",
			_meta: {
				streamIndex: 1,
				runtimeEvent: {
					kind: "status",
					eventType: "runtime.ready",
				},
			},
		}],
	);
});

test("registry retains historical harness mappings and survives repeated concurrent projection", async () => {
	const root = await mkdtemp(join(tmpdir(), "cohub-local-session-repeat-"));
	const workspace = join(root, "workspace");
	const codexArtifact = {
		harness: "codex" as const,
		externalSessionId: CODEX_ID,
		sources: ["message_metadata"],
		path: join(root, "codex.jsonl"),
		format: "codex_rollout_jsonl" as const,
		status: "available" as const,
		checkedAt: "2026-09-01T00:00:01.000Z",
	};
	const first = buildLocalSessionManifest({
		spaceId: SPACE_ID,
		sessionId: SESSION_ID,
		activeHarness: "codex",
		title: "History",
		status: "active",
		createdAt: null,
		updatedAt: new Date("2026-09-01T00:00:01.000Z"),
		nativeSessions: [codexArtifact],
	});
	const cursorArtifact = {
		harness: "cursor" as const,
		externalSessionId: CURSOR_ID,
		sources: ["active_session"],
		path: join(root, "cursor"),
		format: "cursor_acp_directory" as const,
		status: "available" as const,
		checkedAt: "2026-09-01T00:00:02.000Z",
	};
	const next = buildLocalSessionManifest({
		spaceId: SPACE_ID,
		sessionId: SESSION_ID,
		activeHarness: "cursor",
		title: "History",
		status: "active",
		createdAt: null,
		updatedAt: new Date("2026-09-01T00:00:02.000Z"),
		nativeSessions: [cursorArtifact],
		existing: first,
	});
	assert.deepEqual(next.nativeSessions.map((item) => item.harness), ["codex", "cursor"]);

	const transcript = serializeLocalSessionTranscript({
		spaceId: SPACE_ID,
		sessionId: SESSION_ID,
		activeHarness: "cursor",
		externalSessionId: CURSOR_ID,
		messages: transcriptMessages(),
	});
	await Promise.all(
		Array.from({ length: 8 }, () =>
			writeLocalSessionRegistryFiles({ workspacePath: workspace, manifest: next, transcript }),
		),
	);
	const paths = localSessionRegistryPaths({ workspacePath: workspace, sessionId: SESSION_ID });
	assert.deepEqual(JSON.parse(await readFile(paths.manifest, "utf8")), next);
	assert.equal(await readFile(paths.transcript, "utf8"), transcript);
});
