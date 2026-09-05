import assert from "node:assert/strict";
import test from "node:test";
import { resumeCodexThreadWithRetry } from "../codex-thread-resume.js";

test("Codex resume waits for the previous active writer and keeps the same thread", async () => {
	let attempts = 0;
	const waits: number[] = [];
	const notices: Array<{ attempt: number; delayMs: number }> = [];
	const result = await resumeCodexThreadWithRetry({
		resume: async () => {
			attempts += 1;
			if (attempts < 3) {
				throw new Error("Codex app-server thread/resume failed: thread native-1 already has an active writer");
			}
			return { thread: { id: "native-1" } };
		},
		delaysMs: [10, 20, 40],
		sleep: async (delayMs) => { waits.push(delayMs); },
		onRetry: (notice) => { notices.push(notice); },
	});

	assert.deepEqual(result, { thread: { id: "native-1" } });
	assert.equal(attempts, 3);
	assert.deepEqual(waits, [10, 20]);
	assert.deepEqual(notices, [
		{ attempt: 1, delayMs: 10 },
		{ attempt: 2, delayMs: 20 },
	]);
});

test("Codex resume does not retry unrelated failures", async () => {
	let attempts = 0;
	await assert.rejects(
		resumeCodexThreadWithRetry({
			resume: async () => {
				attempts += 1;
				throw new Error("authentication required");
			},
			delaysMs: [1],
			sleep: async () => undefined,
		}),
		/authentication required/,
	);
	assert.equal(attempts, 1);
});
