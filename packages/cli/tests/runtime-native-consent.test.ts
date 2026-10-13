import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ensureNativeSync } from "../src/runtime/native/attach.js";
import { nativeConfigPath, readNativeConfig, runtimeStateRoot, writeNativeConfig, type NativeConfig } from "../src/runtime/native/config.js";
import { workbuddySessionPath } from "../src/runtime/native/workbuddy-transcript.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cohub-native-consent-"));
  const original = { HOME: process.env.HOME, WORKBUDDY_HOME: process.env.WORKBUDDY_HOME };
  process.env.HOME = root;
  process.env.WORKBUDDY_HOME = join(root, "workbuddy");
  const input = { root: join(root, "project"), spaceId: "consent-space", identity: "consent-user", harnesses: ["codex", "workbuddy"] as NativeConfig["harnesses"] };
  const previous: NativeConfig = { version: 2, identity: input.identity, spaceId: input.spaceId, root: input.root, harnesses: ["codex"], enabledAt: "2025-01-01T00:00:00.000Z", codexShared: true };
  const stateRoot = runtimeStateRoot(input.spaceId);
  await writeNativeConfig(stateRoot, previous);
  const path = workbuddySessionPath(process.env.WORKBUDDY_HOME, input.root, "11111111-1111-4111-8111-111111111111");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ type: "message", id: "old-user", sessionId: "11111111-1111-4111-8111-111111111111", cwd: input.root, timestamp: "2024-01-01T00:00:00.000Z", role: "user", content: [{ type: "input_text", text: "private history" }] })}\n`);
  await utimes(path, new Date("2024-01-01"), new Date("2024-01-01"));
  return { input, previous, stateRoot, async close() {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  } };
}

test("adding WorkBuddy offers only its earlier history and preserves existing consent", async () => {
  const f = await fixture();
  try {
    const report = await ensureNativeSync({ ...f.input, yes: true }, () => {});
    assert.equal(report.importHistory, true);
    assert.deepEqual(report.importHarnesses, ["workbuddy"]);
    assert.deepEqual(await readNativeConfig(f.stateRoot, f.input.identity), { ...f.previous, harnesses: ["codex", "workbuddy"] });
  } finally { await f.close(); }
});

test("declining newly added WorkBuddy history does not request any import", async () => {
  const f = await fixture();
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  try {
    const questions: string[] = [];
    const report = await ensureNativeSync(f.input, () => {}, async (question) => { questions.push(question); return questions.length === 1; });
    assert.equal(questions.length, 2);
    assert.match(questions[0] ?? "", /history may contain secrets/);
    assert.match(questions[1] ?? "", /Import 1 earlier conversation.*WorkBuddy/);
    assert.equal(report.importHistory, false);
    assert.deepEqual(report.importHarnesses, []);
  } finally {
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty); else Reflect.deleteProperty(process.stdin, "isTTY");
    await f.close();
  }
});

test("damaged existing consent is surfaced and never replaced while adding WorkBuddy", async () => {
  const f = await fixture();
  try {
    await writeFile(nativeConfigPath(f.stateRoot), "{damaged");
    await assert.rejects(ensureNativeSync({ ...f.input, harnesses: ["workbuddy"], yes: true }, () => {}), SyntaxError);
    assert.equal(await readFile(nativeConfigPath(f.stateRoot), "utf8"), "{damaged");
  } finally { await f.close(); }
});
