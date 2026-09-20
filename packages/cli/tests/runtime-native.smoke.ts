import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessArchive, RuntimeContextMessage, RuntimeExecutionEvent, RuntimeTurnInput } from "@neta-art/cohub";
import { executeCodex, executePi } from "../src/runtime/harness.js";
import { RuntimeSessionStore } from "../src/runtime/session-store.js";
import { archiveStorageFixture } from "./fixtures/runtime-archive-storage.js";

// Explicit opt-in: callers provide isolated, configured native homes and model credentials.
function required(key: string) {
  const value = process.env[key];
  if (!value) throw new Error(`Set ${key} for the native Runtime smoke test`);
  return value;
}
const home = required("COHUB_NATIVE_TEST_HOME");
const provider = required("COHUB_NATIVE_TEST_PROVIDER");
const model = required("COHUB_NATIVE_TEST_MODEL");
process.env.HOME = join(home, "home");
process.env.PI_CODING_AGENT_DIR = join(home, "pi");
process.env.CODEX_HOME = join(home, "codex");
const options = { pi: process.env.COHUB_NATIVE_TEST_PI_BIN, codex: process.env.COHUB_NATIVE_TEST_CODEX_BIN };

for (const original of ["pi", "codex"] as const) {
  const root = await mkdtemp(join(home, `smoke-${original}-`));
  const spaceId = randomUUID(), sessionId = randomUUID();
  const marker = `CANARY_${randomUUID().slice(0, 8)}`;
  const storage = await archiveStorageFixture();
  let store = new RuntimeSessionStore(spaceId, join(root, "state"), storage.transport);
  const history: RuntimeContextMessage[] = [];
  let archive: HarnessArchive | null | undefined;
  let revision = "initial";
  let throughTurnId: string | null = null;

  async function run(harness: "pi" | "codex", stage: string, prompt: string, hot = false, interrupt = false) {
    const turnId = randomUUID(), userMessageId = randomUUID();
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    const events: RuntimeExecutionEvent[] = [];
    let firstDeltaMs: number | null = null;
    const input: RuntimeTurnInput = {
      spaceId, sessionId, turnId, userMessageId, harness, provider, model,
      accessMode: "full_access", messages: [{ turnId, userMessageId, userId: "author", content: [{ type: "text", text: prompt }] }],
      context: { complete: !hot, revision, throughTurnId, messages: hot ? [] : history, archive: hot ? null : archive },
    };
    try {
      const result = await (harness === "pi" ? executePi : executeCodex)(input, options, root, store, (event) => {
        events.push(event);
        if (event.type === "text.delta") firstDeltaMs ??= Date.now() - started;
        if (interrupt && event.type === "text.delta" && event.kind === "text") controller.abort();
      }, controller.signal);
      const output = result.event.message.content.map((block) => block.type === "text" ? block.text : "").join("");
      const messages = events.flatMap((event) => event.type === "message.commit" ? [event.message] : []).concat(result.event.message);
      const toolBlocks = messages.flatMap((message) => message.content).filter((block) => block.type === "tool_use").length;
      await store.archives.flush(AbortSignal.timeout(60_000));
      console.log(JSON.stringify({ harness, stage, ms: Date.now() - started, firstDeltaMs, resume: result.event.resume, stop: result.event.message.stopReason, toolBlocks, outputChars: output.length, archiveBytes: storage.versions.get(turnId)?.sizeBytes ?? 0, tokens: result.event.message.usage?.totalTokens }));
      assert.equal(result.event.message.stopReason, interrupt ? "aborted" : "stop");
      assert.notEqual(firstDeltaMs, null, "must stream before completion");
      assert(result.event.archive?.turnId === turnId, "native archive reference must be available");
      if (!interrupt) assert((result.event.message.usage?.totalTokens ?? 0) > 0, "native usage must be represented");
      await store.recordResult(result.state, randomUUID(), [...events.filter((event) => event.type === "message.commit"), result.event]);
      history.push({ id: input.userMessageId, turnId, role: "user", content: input.messages[0]?.content ?? [] }, ...messages.map((message): RuntimeContextMessage => ({ id: randomUUID(), turnId, role: "assistant", content: message.content, provider: message.provider, model: message.model })));
      revision = `after-${turnId}`;
      throughTurnId = turnId;
      archive = result.event.archive;
      await store.acknowledge(result.state, turnId, revision);
      return { output, toolBlocks, resume: result.event.resume };
    } finally { clearTimeout(timeout); }
  }

  try {
    await run(original, "new", `Remember the exact marker ${marker}. No tools. Reply MEMORY_OK.`);
    assert((await run(original, "native", "Reply with the exact marker from my preceding message. No tools.", true)).output.includes(marker));
    const tool = await run(original, "tool", `Create cohub-smoke.txt in the current working directory, containing exactly ${marker}. Use a tool. Then reply TOOL_OK.`, true);
    assert(tool.toolBlocks > 0, "native tools must appear in public messages");
    assert.equal((await readFile(join(root, "cohub-smoke.txt"), "utf8")).trim(), marker);
    store = new RuntimeSessionStore(spaceId, join(root, "restored"), storage.transport);
    const restored = await run(original, "archive", "Without tools, what is the exact marker I asked you to remember?");
    assert.equal(restored.resume, "restored");
    assert(restored.output.includes(marker));
    const other = original === "pi" ? "codex" : "pi";
    const handoff = await run(other, `${original}->${other}`, "Without tools, what is the exact marker I asked you to remember?");
    assert.equal(handoff.resume, "handoff");
    assert(handoff.output.includes(marker));
    const aborted = await run(other, "abort", "Output all integers from 1 to 5000, each on a new line. No tools. No explanation.", true, true);
    assert(aborted.output.length > 0, "text streamed before abort must be retained");
  } finally { await storage.close(); await rm(root, { recursive: true, force: true }); }
}
