// Explicit real-account acceptance: four small synthetic prompts, no Cohub cloud upload.
// Reports and native test histories are preserved for inspection.
// COHUB_NATIVE_WORKBUDDY_SMOKE=1 node --import tsx tests/runtime-workbuddy.smoke.ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RuntimeTurnInput, RuntimeExecutionEvent } from '@neta-art/cohub';
import { NativeRuntime } from '../src/runtime/native/daemon.js';
import { RuntimeArchiveStore } from '../src/runtime/archive-store.js';
import { RuntimeDiagnostics } from '../src/runtime/diagnostics.js';
import { executeTurn } from '../src/runtime/native/execution.js';
import { readTranscript } from '../src/runtime/native/adapters.js';
import { discoverWorkBuddy, resolveWorkBuddyLaunch, WorkBuddyProcess, workbuddySessionFile } from '../src/runtime/workbuddy-process.js';
import { runtimeProjectionSource } from './fixtures/runtime-projection-source.js';
import { NativeIngest } from '../src/runtime/native/ingest.js';
import { fakeNativeServer } from './fixtures/native-server.js';

if (process.env.COHUB_NATIVE_WORKBUDDY_SMOKE !== '1') throw new Error('Set COHUB_NATIVE_WORKBUDDY_SMOKE=1 to run four synthetic prompts using your signed-in WorkBuddy account');
const root = await realpath(await mkdtemp(join(tmpdir(), 'cohub-workbuddy-smoke-')));
const spaceId = randomUUID(), sessionId = randomUUID(), stateRoot = join(root, 'state');
const diagnostics = new RuntimeDiagnostics({ root: stateRoot, spaceId });
const native = new NativeRuntime({ spaceId, root, stateRoot, harnesses: ['workbuddy'], executables: {}, identity: 'local-acceptance', config: null, archives: new RuntimeArchiveStore(join(stateRoot, 'archives'), null), projectionSource: runtimeProjectionSource(), diagnostics });
const report: Record<string, unknown> = { root, startedAt: new Date().toISOString() };
const text = (content: {type:string; text?:string}[]) => content.filter(x => x.type === 'text').map(x => x.text ?? '').join('\n');
const makeInput = (prompt: string): RuntimeTurnInput => {
  const turnId = randomUUID(), userMessageId = randomUUID();
  return { spaceId, sessionId, turnId, userMessageId, harness: 'workbuddy', accessMode: 'full_access', context: { complete: true, revision: 'new', throughTurnId: null, messages: [] }, messages: [{ turnId, userMessageId, userId: 'local-acceptance', content: [{ type: 'text', text: prompt }] }] };
};
try {
  const catalog = await discoverWorkBuddy(root);
  report.models = catalog.models.map(x => x.id);
  report.defaultModel = catalog.currentModelId;
  console.log(JSON.stringify({ stage: 'catalog', models: catalog.models.length, currentModel: catalog.currentModelId }));
  const nativeProject = join(root, 'native');
  await mkdir(nativeProject);
  const nativeId = randomUUID(), launch = await resolveWorkBuddyLaunch(nativeProject);
  const host = new WorkBuddyProcess(launch, nativeProject, { sessionId: nativeId });
  try {
    await host.initialize();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Native prompt timed out')), 90_000);
      host.onFailure((error) => { clearTimeout(timer); reject(error); });
      host.onEvent((event) => {
        if (event.type !== 'result') return;
        clearTimeout(timer);
        if (event.is_error) reject(new Error('Native prompt failed')); else resolve();
      });
      host.prompt({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Connectivity test. Do not use tools or modify files. Reply with exactly WB_NATIVE_OK.' }] } });
    });
  } finally { await host.close(); }
  const nativePath = workbuddySessionFile(launch.home, nativeProject, nativeId);
  const originalNative = await readFile(nativePath);
  const nativeTranscript = await readTranscript(nativePath, 'workbuddy');
  assert.equal(nativeTranscript.turns.length, 1);
  const nativeTurn = nativeTranscript.turns[0];
  assert.ok(nativeTurn);
  assert.equal(text(nativeTurn.messages.flatMap((message) => message.content)).trim(), 'WB_NATIVE_OK');
  const server = fakeNativeServer(), syncErrors: unknown[] = [];
  const ingest = new NativeIngest({ spaceId, cwd: nativeProject, harnesses: ['workbuddy'], enabledAt: new Date(0).toISOString(), root: join(root, 'ingest'), archives: new RuntimeArchiveStore(join(root, 'ingest-archives'), null), hooks: { onError: (error) => syncErrors.push(error) } });
  const waitForImport = async () => {
    const deadline = Date.now() + 15_000;
    while (ingest.status().import.state === 'running' || ingest.status().live > 0) {
      if (Date.now() > deadline) throw new Error('Native import did not finish');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ingest.status().import.state, 'done');
    assert.deepEqual(ingest.status().import.failed, []);
  };
  try {
    await ingest.load();
    const plan = await ingest.plan({ harnesses: ['workbuddy'], nativeSessionId: nativeId });
    assert.deepEqual(plan.map((item) => item.path), [nativePath]);
    ingest.connect(server.transport);
    await ingest.startImport({ harnesses: ['workbuddy'], nativeSessionId: nativeId });
    const deadline = Date.now() + 15_000;
    while (server.turns.size !== 1 || ![...server.turns.values()].every((turn) => turn.settled)) {
      assert.deepEqual(syncErrors, []);
      if (Date.now() > deadline) throw new Error('Native history import did not settle');
      await new Promise((resolve) => setTimeout(resolve, 100));
      await ingest.scan();
    }
    await waitForImport();
    const imported = server.batches.flatMap((batch) => batch.turns).find((turn) => turn.result !== null);
    assert.ok(imported, 'Completed native reply must be delivered');
    assert.ok(imported.result);
    assert.equal(text(imported.result.messages.flatMap((message) => message.content)).trim(), 'WB_NATIVE_OK');
    assert.deepEqual(syncErrors, []);
    const batchCount = server.batches.length;
    await ingest.startImport({ harnesses: ['workbuddy'], nativeSessionId: nativeId });
    await waitForImport();
    assert.equal(server.batches.length, batchCount);
    assert.deepEqual(await readFile(nativePath), originalNative);
    report.history = { passed: true, nativePath, importedTurns: server.turns.size, duplicates: 0, originalUnchanged: true, destination: 'local in-memory transport' };
    console.log(JSON.stringify({ stage: 'history', passed: true, turns: server.turns.size }));
  } finally { await ingest.close(AbortSignal.timeout(5_000)); }
  const token = `WB_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const first = makeInput(`This is a connectivity acceptance test. Do not use tools or modify files. Remember this token for the next message: ${token}. Reply with exactly ${token} and nothing else.`);
  const events: RuntimeExecutionEvent[] = [];
  const firstResult = await executeTurn(native.executor, first, event => events.push(event), AbortSignal.timeout(90_000), randomUUID());
  report.first = { stopReason: firstResult.event.message.stopReason, error: firstResult.event.message.errorMessage, nativeSessionId: firstResult.session.nativeSessionId, path: firstResult.session.path, reply: text(firstResult.event.message.content), eventTypes: events.map(x=>x.type) };
  assert.equal(firstResult.event.message.stopReason, 'stop');
  assert.equal(text(firstResult.event.message.content).trim(), token);
  const original = await readFile(firstResult.session.path);
  const firstTranscript = await readTranscript(firstResult.session.path, 'workbuddy');
  assert.equal(firstTranscript.turns.at(-1)?.cloudTurnId, first.turnId);
  await native.executor.results.record(firstResult.session, first, null, [firstResult.event]);
  await native.executor.results.acknowledge(first.sessionId, first.turnId);
  console.log(JSON.stringify({ stage: 'new-turn', passed: true, streamed: events.some(x=>x.type==='text.delta') }));

  const next = makeInput('Without using tools, what exact verification token did I ask you to remember in the previous message? Reply with only that token.');
  next.context = { complete: true, revision: 'next', throughTurnId: first.turnId, messages: [], archive: firstResult.event.archive };
  const second = await executeTurn(native.executor, next, () => {}, AbortSignal.timeout(90_000), randomUUID());
  report.continuation = { stopReason: second.event.message.stopReason, error: second.event.message.errorMessage, reply: text(second.event.message.content), nativeSessionId: second.session.nativeSessionId, path: second.session.path, resume: second.event.resume };
  assert.equal(second.event.message.stopReason, 'stop');
  assert.equal(text(second.event.message.content).trim(), token);
  assert.notEqual(second.session.nativeSessionId, firstResult.session.nativeSessionId);
  assert.deepEqual(await readFile(firstResult.session.path), original);
  const secondTranscript = await readTranscript(second.session.path, 'workbuddy');
  assert.equal(secondTranscript.turns.length, 1);
  assert.equal(secondTranscript.turns[0]?.cloudTurnId, next.turnId);
  report.continuationOriginalUnchanged = true;
  await native.executor.results.record(second.session, next, null, [second.event]);
  await native.executor.results.acknowledge(next.sessionId, next.turnId);
  console.log(JSON.stringify({ stage: 'continuation', passed: true, originalUnchanged: true }));

  const stopInput = makeInput('Do not use tools or modify files. Print the integers 1 through 10000, one per line. Start immediately with 1.');
  stopInput.sessionId = randomUUID();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Acceptance timeout')), 90_000);
  let stoppedAfterDelta = false;
  const stopped = await executeTurn(native.executor, stopInput, event => { if (event.type === 'text.delta' && event.kind === 'text' && event.delta.trim()) { stoppedAfterDelta = true; controller.abort(new Error('Acceptance stop')); } }, controller.signal, randomUUID());
  clearTimeout(timeout);
  report.stop = { stopReason: stopped.event.message.stopReason, stoppedAfterDelta, cleanupConfirmed: !stopped.uncertainCleanup, partialTextLength: text(stopped.event.message.content).length, path: stopped.session.path };
  assert.equal(stoppedAfterDelta, true);
  assert.ok(text(stopped.event.message.content).length > 0, 'Stopping must preserve the visible partial reply');
  assert.equal(stopped.event.message.stopReason, 'aborted');
  assert.equal(stopped.uncertainCleanup, undefined);
  console.log(JSON.stringify({ stage: 'stop', passed: true, cleanupConfirmed: true }));
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ stage: 'failure', failure: report.failure, root }));
  process.exitCode = 1;
} finally {
  await native.close(AbortSignal.timeout(5_000));
  await diagnostics.close();
  report.completedAt = new Date().toISOString();
  await writeFile(join(root, 'acceptance.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ report: join(root, 'acceptance.json') }));
}
