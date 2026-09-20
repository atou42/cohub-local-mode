import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { contextToPiMessages, RUNTIME_RECOVERY_BATCH_SIZE, selectRuntimeContextMessages, runtimeEventSchema, type RuntimeExecutionEvent, type HarnessArchive, type RuntimePendingExecution, type RuntimeTurnInput } from "@neta-art/cohub";
import { RuntimeArchiveStore, checksumNativeFile, atomicRuntimeJson as atomicJson, type ArchiveTransport } from "./archive-store.js";
import type { CodexTokenTotals } from "./codex-usage.js";
import { importNativeArchive, readCodexArchiveTotals } from "./native-archive.js";
import { serializeDiagnosticError, type RuntimeDiagnosticContext, type RuntimeDiagnostics } from "./diagnostics.js";

export class ContextRequiredError extends Error {
  constructor(message: string, readonly historyOnly = false) { super(message); }
}

export type NativeSession = {
  version: 1;
  sessionId: string;
  harness: "pi" | "codex";
  nativeSessionId: string;
  path: string;
  cwd?: string;
  throughTurnId: string | null;
  revision: string;
  checksum: string;
  pendingTurnId: string | null;
  resultChecksum?: string;
  archivePendingTurnId?: string;
  codexTokenTotals?: CodexTokenTotals;
};
const checksum = (data: string) => createHash("sha256").update(data).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
class CaptureUnavailableError extends Error {}

/** Local references are hints validated against actual native files, never cloud existence claims. */
export class RuntimeSessionStore {
  readonly root: string;
  readonly archives: RuntimeArchiveStore;
  private archiveFlush: Promise<void> | null = null;
  private diagnostics: RuntimeDiagnostics | null = null;
  constructor(spaceId: string, stateRoot = join(homedir(), ".local", "state", "cohub", "runtime"), transport?: ArchiveTransport) {
    this.root = join(stateRoot, spaceId);
    this.archives = new RuntimeArchiveStore(join(this.root, "archives"), transport);
  }
  setDiagnostics(diagnostics: RuntimeDiagnostics): void {
    this.diagnostics = diagnostics;
    this.archives.setErrorReporter((error, index) => diagnostics.log("warn", "archive.upload_pending", { error: serializeDiagnosticError(error) }, {
      component: "archive",
      sessionId: index?.sessionId,
      turnId: index?.turnId,
      harness: index?.harness,
    }));
  }
  private statePath(input: Pick<RuntimeTurnInput, "sessionId" | "harness">) { return join(this.root, input.harness, `${input.sessionId}.json`); }
  async *pendingExecutionBatches(): AsyncGenerator<RuntimePendingExecution[]> {
    let batch: RuntimePendingExecution[] = [];
    for (const harness of ["pi", "codex"] as const) {
      const directory = join(this.root, harness);
      const names = await readdir(directory).catch((error) => { if (missing(error)) return []; throw error; });
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        try {
          const state = JSON.parse(await readFile(join(directory, name), "utf8")) as NativeSession;
          if (state.version !== 1 || state.harness !== harness || !state.sessionId || !state.pendingTurnId) continue;
          batch.push({ sessionId: state.sessionId, turnId: state.pendingTurnId, harness });
          if (batch.length >= RUNTIME_RECOVERY_BATCH_SIZE) {
            yield batch;
            batch = [];
          }
        } catch (error) {
          this.diagnostics?.log("error", "runtime.session_state_unreadable", { path: join(directory, name), error: serializeDiagnosticError(error) });
          console.error(`Runtime session state unreadable: ${join(directory, name)}`, error);
        }
      }
    }
    if (batch.length) yield batch;
  }
  async flushArchives(signal: AbortSignal) {
    this.archiveFlush ??= this.flushArchiveOutbox(signal).finally(() => { this.archiveFlush = null; });
    return this.archiveFlush;
  }
  private async flushArchiveOutbox(signal: AbortSignal) {
    const captures = join(this.archives.root, "captures");
    const names = await readdir(captures).catch((error) => { if (missing(error)) return []; throw error; });
    for (const name of names) {
      signal.throwIfAborted();
      if (!name.endsWith(".json")) continue;
      let receipt: string | undefined;
      try {
        receipt = await readFile(join(captures, name), "utf8");
        let state: NativeSession;
        try { state = JSON.parse(receipt) as NativeSession; }
        catch { throw new CaptureUnavailableError("Invalid capture receipt"); }
        const turnId = state?.archivePendingTurnId;
        if (typeof turnId !== "string" || typeof state?.path !== "string" || typeof state.resultChecksum !== "string") {
          throw new CaptureUnavailableError("Invalid capture receipt");
        }
        if (!await this.archives.hasCapture(turnId)) {
          const digest = await checksumNativeFile(state.path).catch((error) => {
            if (missing(error)) throw new CaptureUnavailableError("Native session missing");
            throw error;
          });
          if (digest !== state.resultChecksum) throw new CaptureUnavailableError("Native session changed; original files retained");
          signal.throwIfAborted();
          await this.archives.stage(state, turnId);
        }
        await rm(join(captures, name), { force: true });
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof CaptureUnavailableError && receipt !== undefined) {
          // Preserve the exact receipt before retiring it from the retry queue. Never alter native files.
          await atomicJson(join(this.archives.root, "failed", "captures", `${name}.${checksum(receipt)}.json`), {
            receipt, reason: error.message, failedAt: new Date().toISOString(),
          });
          await rm(join(captures, name), { force: true });
          this.diagnostics?.log("error", "archive.capture_unavailable", { reason: error.message, receipt: true }, { component: "archive" });
          console.error("Archive capture unavailable; receipt retained:", error.message);
        } else {
          this.diagnostics?.log("warn", "archive.capture_pending", { error: serializeDiagnosticError(error) }, { component: "archive" });
          console.error("Archive capture pending:", error);
        }
      }
    }
    await this.archives.flush(signal);
  }
  async pendingTurnIds(sessionId: string): Promise<string[]> {
    const ids: string[] = [];
    for (const harness of ["pi", "codex"] as const) {
      try {
        const state = JSON.parse(await readFile(this.statePath({ sessionId, harness }), "utf8")) as NativeSession;
        if (state.sessionId !== sessionId || state.harness !== harness) throw new Error("Local session identity mismatch");
        if (state.pendingTurnId) ids.push(state.pendingTurnId);
      } catch (error) { if (!missing(error)) throw error; }
    }
    return ids;
  }
  async prepare(input: RuntimeTurnInput, cwd: string, signal?: AbortSignal): Promise<{ state: NativeSession; resume: "native" | "restored" | "handoff" | "new" }> {
    let previous: NativeSession | null = null;
    try { previous = JSON.parse(await readFile(this.statePath(input), "utf8")) as NativeSession; }
    catch (error) { if (!missing(error)) throw new Error("Local session state is unreadable; original files were preserved", { cause: error }); }
    if (previous) {
      if (previous.sessionId !== input.sessionId || previous.harness !== input.harness) throw new Error("Local session identity mismatch");
      const pending = previous.pendingTurnId;
      if (pending) {
        const resolved = input.context.resolvedTurnIds?.includes(pending) === true;
        const settled = input.context.settledTurnIds?.includes(pending) === true;
        const lostAcknowledgement = Boolean(previous.resultChecksum) && pending === input.context.throughTurnId && pending !== input.turnId;
        // A human-confirmed stop is authoritative: rebuild from durable history instead of
        // resuming a native projection whose outcome the server never recorded.
        const retire = resolved || (settled && !lostAcknowledgement);
        const nativeChecksum = await checksumNativeFile(previous.path).catch((error) => { if (missing(error)) return null; throw error; });
        if (previous.resultChecksum && (settled || resolved) && nativeChecksum && nativeChecksum !== previous.resultChecksum) {
          throw new Error("Native session changed outside Cohub; original data was preserved");
        }
        if (retire) {
          // The server reached a terminal state for this turn. Archive the local projection and
          // rebuild from durable context; native files are never deleted, so nothing is lost.
          const receipt = await readFile(this.resultPath(previous), "utf8").catch((error) => { if (missing(error)) return null; throw error; });
          const retired = { state: previous, receipt };
          await atomicJson(join(this.root, "retired", `${pending}.${checksum(JSON.stringify(retired))}.json`), retired);
          previous = null;
        } else if (lostAcknowledgement) {
          // The server already persisted this turn; only our acknowledgement was lost.
          await this.acknowledge(previous, pending, input.context.revision);
        } else if (input.context.complete === false) {
          throw new ContextRequiredError("Server resolution is required for the pending native execution");
        } else {
          throw new Error(`Local turn ${pending} has unconfirmed results; reconcile it before continuing`);
        }
      }
    }
    if (previous) {
      try {
        if (await checksumNativeFile(previous.path) !== previous.checksum) throw new Error("Native session changed outside Cohub; original data was preserved");
        if (previous.archivePendingTurnId) {
          await this.archives.stage(previous, previous.archivePendingTurnId);
          previous.archivePendingTurnId = undefined;
          await atomicJson(this.statePath(previous), previous);
        }
        if (input.harness === "codex" && !previous.codexTokenTotals) previous.codexTokenTotals = await readCodexArchiveTotals(previous.path);
        if (previous.cwd === cwd && previous.throughTurnId === input.context.throughTurnId && previous.revision === input.context.revision) return { state: previous, resume: "native" };
      } catch (error) { if (!missing(error)) throw error; }
    }
    if (input.context.complete === false && !input.context.archive) throw new ContextRequiredError("Full context is required to materialize this session");
    const id = randomUUID();
    const path = join(this.root, input.harness, `${id}.jsonl`);
    const archive = input.context.archive;
    const restore = archive?.harness === input.harness && archive.sessionId === input.sessionId && archive.turnId === input.context.throughTurnId;
    const rawPath = join(this.root, "archives", "restored", `${id}.jsonl`);
    const state: NativeSession = {
      version: 1, harness: input.harness, sessionId: input.sessionId, nativeSessionId: id,
      path, cwd, throughTurnId: input.context.throughTurnId, revision: input.context.revision, checksum: "", pendingTurnId: null,
    };
    if (restore) {
      try {
        const restored = await this.archives.restore(archive, rawPath, signal);
        Object.assign(state, await importNativeArchive({ source: rawPath, target: path, harness: input.harness, nativeSessionId: restored.nativeSessionId, id, cwd, signal }));
        return { state, resume: "restored" };
      } catch (error) {
        signal?.throwIfAborted();
        this.diagnostics?.log("warn", "archive.restore_failed", { error: serializeDiagnosticError(error) }, { component: "archive" });
        console.error("Native archive unavailable; rebuilding from durable history:", error);
      }
    }
    if (input.context.complete === false) throw new ContextRequiredError("Database history is required after archive recovery failed", true);
    let data: string | null = null;
    if (input.harness === "pi") {
      const entries: Record<string, unknown>[] = [{ type: "session", version: 3, id, cwd, timestamp: new Date().toISOString() }];
      let parentId: string | null = null;
      const history = selectRuntimeContextMessages(input.context.messages);
      const summary = history[0]?.role === "system" ? history[0].content.find((block) => block.type === "system_note" && block.note_type === "compacted") : undefined;
      let compaction: Record<string, unknown> | undefined;
      if (summary?.type === "system_note") {
        parentId = randomUUID().slice(0, 8);
        compaction = { type: "compaction", id: parentId, parentId: null, timestamp: new Date().toISOString(), summary: summary.text,
          firstKeptEntryId: "", tokensBefore: (history[0]?.meta?.compaction as { tokensBefore?: number } | undefined)?.tokensBefore ?? 0 };
        entries.push(compaction);
      }
      for (const message of contextToPiMessages(history)) {
        const entryId = randomUUID().slice(0, 8);
        if (compaction && !compaction.firstKeptEntryId) compaction.firstKeptEntryId = entryId;
        entries.push({ type: "message", id: entryId, parentId, timestamp: new Date().toISOString(), message });
        parentId = entryId;
      }
      data = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    }
    if (data != null) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const file = await open(path, "wx", 0o600);
      try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
      state.checksum = checksum(data);
    }
    return { state, resume: input.context.messages.length ? "handoff" : "new" };
  }
  async started(state: NativeSession, turnId: string) { state.pendingTurnId = turnId; state.resultChecksum = undefined; await atomicJson(this.statePath(state), state); }
  private resultPath(state: Pick<NativeSession, "sessionId" | "harness">) { return join(this.root, "results", `${state.sessionId}.${state.harness}.json`); }
  async recordResult(state: NativeSession, requestId: string, events: RuntimeExecutionEvent[]) {
    if (!state.pendingTurnId) throw new Error("Cannot record a result for an idle native session");
    state.resultChecksum = await checksumNativeFile(state.path);
    if (state.archivePendingTurnId) await atomicJson(join(this.archives.root, "captures", `${state.archivePendingTurnId}.json`), state);
    await atomicJson(this.resultPath(state), { requestId, state, events });
    await atomicJson(this.statePath(state), state);
  }
  async recoverResult(input: Pick<RuntimeTurnInput, "sessionId" | "harness" | "turnId">, requestId?: string): Promise<{ state: NativeSession; events: RuntimeExecutionEvent[] } | null> {
    try {
      const saved = JSON.parse(await readFile(this.resultPath(input), "utf8")) as { requestId: string; state: NativeSession; events: unknown[] };
      if (saved.state.sessionId !== input.sessionId || saved.state.harness !== input.harness) throw new Error("Runtime result identity mismatch");
      if (saved.state.pendingTurnId !== input.turnId) return null;
      if (requestId && saved.requestId !== requestId) throw new Error("Runtime result execution identity mismatch");
      return { state: saved.state, events: saved.events.map((event) => runtimeEventSchema.parse(event)) };
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  async archive(state: NativeSession, turnId: string, diagnosticContext: RuntimeDiagnosticContext = {}): Promise<HarnessArchive | null> {
    if (!state.path) return null;
    state.archivePendingTurnId = turnId;
    try {
      const reference = await this.archives.stage(state, turnId);
      state.archivePendingTurnId = undefined;
      return reference;
    } catch (error) {
      this.diagnostics?.log("warn", "archive.capture_failed", { error: serializeDiagnosticError(error) }, { ...diagnosticContext, component: "archive", turnId, harness: state.harness });
      throw error;
    }
  }
  async acknowledge(state: NativeSession, turnId: string, revision: string) {
    if (state.pendingTurnId !== turnId) throw new Error("Runtime acknowledgement identity mismatch");
    const currentChecksum = await checksumNativeFile(state.path).catch((error) => { if (missing(error)) return state.resultChecksum ?? state.checksum; throw error; });
    if (state.resultChecksum && currentChecksum !== state.resultChecksum) throw new Error("Native data changed before acknowledgement; files preserved");
    const acknowledged: NativeSession = { ...state, checksum: currentChecksum, pendingTurnId: null, resultChecksum: undefined, throughTurnId: turnId, revision };
    await atomicJson(this.statePath(state), acknowledged);
    Object.assign(state, acknowledged);
  }
}
