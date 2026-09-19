import type { SandboxConnection } from "@cohub/sandbox-client";
import type {
  AccessMode,
  ExternalHarnessProgress,
  ExternalHarnessResult,
  HarnessEventReducer,
} from "./external-harness-protocol.js";
import { tracedRpc } from "./sandbox/tools.js";
import { localSpaceAccessKey } from "./local-space-access.js";

const SANDBOX_WORKSPACE = "/workspace";
const PROCESS_TIMEOUT_SECONDS = 24 * 60 * 60;
const REQUEST_TIMEOUT_MS = 30_000;
const STARTUP_REQUEST_TIMEOUT_MS = 90_000;
const PROMPT_TIMEOUT_MS = 60 * 60_000;
const IDLE_TIMEOUT_MS = 15 * 60_000;
const MAX_RUNTIMES = 8;
const MAX_JSON_LINE_CHARS = 16 * 1024 * 1024;
const CURSOR_EFFORTS_BY_MODEL = {
  "grok-4.5": new Set(["low", "medium", "high"]),
  "grok-4.6": new Set(["low", "medium", "high", "xhigh"]),
  "claude-fable-5-1": new Set(["low", "medium", "high", "xhigh", "max"]),
} as const;

/**
 * Cursor's ACP picker currently advertises only the default variant. The CLI
 * still accepts the complete variant slug at process startup, which is the
 * supported way to pin a non-default effort for an ACP session.
 */
export function cursorCliModelId(model: string, thinkingLevel: string): string {
  const baseId = model.split("[", 1)[0]?.trim() ?? model.trim();
  const supportedEfforts = CURSOR_EFFORTS_BY_MODEL[baseId as keyof typeof CURSOR_EFFORTS_BY_MODEL];
  if (!supportedEfforts) return model;
  if (!supportedEfforts.has(thinkingLevel)) {
    throw new Error(`Cursor effort is unsupported for ${baseId}: ${thinkingLevel}`);
  }
  if (baseId === "grok-4.6" || baseId === "grok-4.5") {
    const fast = /\bfast=true\b/i.test(model);
    return `cursor-${baseId}-${thinkingLevel}${fast ? "-fast" : ""}`;
  }
  if (baseId === "claude-fable-5-1") {
    const thinking = /\bthinking=true\b/i.test(model);
    return `claude-fable-5-1-${thinking ? "thinking-" : ""}${thinkingLevel}`;
  }
  return model;
}

export function buildCursorAppServerArgv(
  model: string,
  writableRoots: readonly string[] = [],
  command = process.env.CURSOR_AGENT_COMMAND?.trim() || "agent",
) {
  return [
    command,
    "--model",
    model,
    "--sandbox",
    "enabled",
    ...writableRoots.flatMap((root) => ["--add-dir", root]),
    "acp",
  ];
}

type PendingRequest = {
  method: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ActiveTurn = {
  reducer: HarnessEventReducer;
  onProgress?: (progress: ExternalHarnessProgress) => void;
  resolve: (result: ExternalHarnessResult) => void;
  reject: (error: Error) => void;
  abortRequested: boolean;
};

type RuntimeEntry = {
  key: string;
  spaceId: string;
  cohubSessionId: string;
  connection: SandboxConnection;
  workspaceCwd: string;
  accessMode: AccessMode;
  requestedSessionId: string | null;
  externalSessionId: string | null;
  configuredModel: string | null;
  configuredMode: string | null;
  processId: string | null;
  processIdPromise: Promise<string>;
  processPromise: Promise<unknown>;
  readyPromise: Promise<void>;
  stdoutBuffer: string;
  nextRequestId: number;
  pending: Map<string, PendingRequest>;
  writeChain: Promise<void>;
  activeTurn: ActiveTurn | null;
  pendingRuntimeEvents: Array<{
    kind: ExternalHarnessProgress["kind"];
    eventType: string;
    message: string;
    raw?: unknown;
  }>;
  lastUsedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
};

const runtimes = new Map<string, RuntimeEntry>();

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function context(entry: RuntimeEntry) {
  return { spaceId: entry.spaceId, sessionId: entry.cohubSessionId };
}

function emit(entry: RuntimeEntry, value: unknown) {
  const turn = entry.activeTurn;
  if (!turn) return;
  const progress = turn.reducer.push(value);
  if (progress) turn.onProgress?.(progress);
}
function emitRuntime(
  entry: RuntimeEntry,
  input: {
    kind: ExternalHarnessProgress["kind"];
    eventType: string;
    message: string;
    raw?: unknown;
  },
) {
  const turn = entry.activeTurn;
  if (!turn) {
    entry.pendingRuntimeEvents.push(input);
    if (entry.pendingRuntimeEvents.length > 100)
      entry.pendingRuntimeEvents.shift();
    return;
  }
  turn.onProgress?.(turn.reducer.pushRuntimeEvent(input));
}
function flushPendingRuntimeEvents(entry: RuntimeEntry) {
  const turn = entry.activeTurn;
  if (!turn) return;
  for (const event of entry.pendingRuntimeEvents.splice(0))
    turn.onProgress?.(turn.reducer.pushRuntimeEvent(event));
}
function clearIdleTimer(entry: RuntimeEntry) {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
}
function rejectPending(entry: RuntimeEntry, error: Error) {
  for (const pending of entry.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  entry.pending.clear();
}
function closeEntry(entry: RuntimeEntry, reason: string) {
  if (entry.closed) return;
  entry.closed = true;
  clearIdleTimer(entry);
  runtimes.delete(entry.key);
  const error = new Error(reason);
  rejectPending(entry, error);
  entry.activeTurn?.reject(error);
  entry.activeTurn = null;
  if (entry.processId)
    void tracedRpc(
      entry.connection,
      "process.abort",
      { processId: entry.processId },
      { context: context(entry) },
      false,
    ).catch(() => undefined);
}
function scheduleIdleClose(entry: RuntimeEntry) {
  clearIdleTimer(entry);
  if (entry.closed || entry.activeTurn) return;
  entry.idleTimer = setTimeout(
    () => closeEntry(entry, "Cursor runtime idle timeout"),
    IDLE_TIMEOUT_MS,
  );
  entry.idleTimer.unref?.();
}
function evictRuntimeIfNeeded() {
  if (runtimes.size < MAX_RUNTIMES) return;
  const idle = [...runtimes.values()]
    .filter((entry) => !entry.activeTurn)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
  if (!idle) throw new Error("all Cursor runtimes are busy");
  closeEntry(idle, "Cursor runtime evicted");
}
async function writePayload(
  entry: RuntimeEntry,
  payload: Record<string, unknown>,
) {
  const encoded = `${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`;
  const operation = entry.writeChain.then(async () => {
    const processId = await entry.processIdPromise;
    await tracedRpc(
      entry.connection,
      "process.write",
      { processId, chunk: encoded },
      { context: context(entry) },
      false,
    );
  });
  entry.writeChain = operation.catch(() => undefined);
  return operation;
}
function request(
  entry: RuntimeEntry,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = entry.nextRequestId++;
    const key = String(id);
    const timer = setTimeout(() => {
      entry.pending.delete(key);
      reject(new Error(`Cursor ACP ${method} timed out`));
    }, timeoutMs);
    timer.unref?.();
    entry.pending.set(key, { method, resolve, reject, timer });
    void writePayload(entry, { id, method, params }).catch((error) => {
      const pending = entry.pending.get(key);
      if (!pending) return;
      entry.pending.delete(key);
      clearTimeout(pending.timer);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
function notify(
  entry: RuntimeEntry,
  method: string,
  params: Record<string, unknown> = {},
) {
  return writePayload(entry, { method, params });
}

function permissionOption(
  entry: RuntimeEntry,
  params: Record<string, unknown>,
) {
  const options = Array.isArray(params.options)
    ? params.options
        .map(record)
        .filter((item): item is Record<string, unknown> => item !== null)
    : [];
  const preferred =
    entry.accessMode === "full_access"
      ? ["allow_always", "allow_once"]
      : ["reject_always", "reject_once"];
  for (const kind of preferred) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option && text(option.optionId)) return option;
  }
  return null;
}
function respondToAgentRequest(
  entry: RuntimeEntry,
  payload: Record<string, unknown>,
) {
  const id = payload.id;
  const method = text(payload.method);
  if ((typeof id !== "number" && typeof id !== "string") || !method) return;
  const params = record(payload.params) ?? {};
  if (method === "session/request_permission") {
    const option = permissionOption(entry, params);
    emitRuntime(entry, {
      kind:
        option && text(option.kind).startsWith("allow") ? "status" : "warning",
      eventType: method,
      message: option
        ? `Cursor permission ${text(option.kind).startsWith("allow") ? "approved" : "rejected"}`
        : "Cursor permission request could not be resolved",
      raw: params,
    });
    void writePayload(entry, {
      id,
      result: {
        outcome: option
          ? { outcome: "selected", optionId: option.optionId }
          : { outcome: "cancelled" },
      },
    });
    return;
  }
  if (method === "cursor/ask_question" || method === "cursor/create_plan") {
    emitRuntime(entry, {
      kind: "warning",
      eventType: method,
      message: `Cursor requested interactive input (${method}) but this client cannot answer it yet`,
      raw: params,
    });
    void writePayload(entry, {
      id,
      result: { outcome: { outcome: "cancelled" } },
    });
    return;
  }
  emitRuntime(entry, {
    kind: "warning",
    eventType: method,
    message: `Unsupported Cursor request: ${method}`,
    raw: params,
  });
  void writePayload(entry, {
    id,
    error: { code: -32601, message: `unsupported client method: ${method}` },
  });
}
function handlePayload(entry: RuntimeEntry, payload: Record<string, unknown>) {
  if (Object.hasOwn(payload, "id") && payload.method) {
    respondToAgentRequest(entry, payload);
    return;
  }
  if (Object.hasOwn(payload, "id")) {
    const pending = entry.pending.get(String(payload.id));
    if (!pending) return;
    entry.pending.delete(String(payload.id));
    clearTimeout(pending.timer);
    const error = record(payload.error);
    if (error) {
      pending.reject(
        new Error(
          `Cursor ACP ${pending.method} failed: ${text(error.message) || JSON.stringify(error)}`,
        ),
      );
      return;
    }
    pending.resolve(record(payload.result) ?? {});
    return;
  }
  const method = text(payload.method);
  if (method === "session/update") emit(entry, payload);
  else if (method.startsWith("cursor/")) {
    const params = record(payload.params) ?? {};
    emitRuntime(entry, {
      kind: method === "cursor/generate_image" ? "status" : "status",
      eventType: method,
      message: `Cursor ${method.slice("cursor/".length).replaceAll("_", " ")}`,
      raw: params,
    });
  }
}
function handleLine(entry: RuntimeEntry, line: string) {
  const raw = line.trim();
  if (!raw) return;
  try {
    const payload = record(JSON.parse(raw));
    if (!payload) throw new Error("Cursor ACP emitted a non-object message");
    handlePayload(entry, payload);
  } catch (error) {
    const message =
      error instanceof SyntaxError
        ? `Cursor ACP emitted invalid JSON: ${raw.slice(0, 200)}`
        : error instanceof Error
          ? error.message
          : String(error);
    emitRuntime(entry, {
      kind: "stderr",
      eventType: "runtime.stdout.invalid",
      message,
      raw,
    });
    closeEntry(entry, message);
  }
}
function consumeStdout(entry: RuntimeEntry, chunk: string) {
  entry.stdoutBuffer += chunk;
  if (entry.stdoutBuffer.length > MAX_JSON_LINE_CHARS) {
    entry.stdoutBuffer = "";
    closeEntry(
      entry,
      `Cursor ACP emitted a JSON line larger than ${MAX_JSON_LINE_CHARS} characters`,
    );
    return;
  }
  for (;;) {
    const newline = entry.stdoutBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = entry.stdoutBuffer.slice(0, newline);
    entry.stdoutBuffer = entry.stdoutBuffer.slice(newline + 1);
    handleLine(entry, line);
  }
}

function createRuntime(input: {
  key: string;
  spaceId: string;
  cohubSessionId: string;
  connection: SandboxConnection;
  accessMode: AccessMode;
  externalSessionId: string | null;
  environment: Record<string, string>;
  model: string;
  thinkingLevel: string;
  writableRoots: readonly string[];
}) {
  evictRuntimeIfNeeded();
  let resolveProcessId: (id: string) => void = () => undefined;
  let rejectProcessId: (error: Error) => void = () => undefined;
  const processIdPromise = new Promise<string>((resolve, reject) => {
    resolveProcessId = resolve;
    rejectProcessId = reject;
  });
  processIdPromise.catch(() => undefined);
  const entry: RuntimeEntry = {
    key: input.key,
    spaceId: input.spaceId,
    cohubSessionId: input.cohubSessionId,
    connection: input.connection,
    workspaceCwd:
      input.connection.filesystem?.defaultCwd?.trim() || SANDBOX_WORKSPACE,
    accessMode: input.accessMode,
    requestedSessionId: input.externalSessionId,
    externalSessionId: null,
    // ACP does not support reliable in-session model switching. The model is
    // pinned in the process argv below, so do not send a second model switch
    // request after session/new or session/load.
    configuredModel: input.model,
    configuredMode: null,
    processId: null,
    processIdPromise,
    processPromise: Promise.resolve(),
    readyPromise: Promise.resolve(),
    stdoutBuffer: "",
    nextRequestId: 1,
    pending: new Map(),
    writeChain: Promise.resolve(),
    activeTurn: null,
    pendingRuntimeEvents: [],
    lastUsedAt: Date.now(),
    idleTimer: null,
    closed: false,
  };
  entry.processPromise = tracedRpc(
    input.connection,
    "process.start",
    {
      argv: buildCursorAppServerArgv(
        cursorCliModelId(input.model, input.thinkingLevel),
        input.writableRoots,
      ),
      cwd: entry.workspaceCwd,
      env: input.environment,
      timeoutSecs: PROCESS_TIMEOUT_SECONDS,
    },
    {
      context: context(entry),
      onEvent(event) {
        if (event.type === "started") {
          entry.processId = event.processId;
          resolveProcessId(event.processId);
          return;
        }
        if (event.type === "stdout") {
          consumeStdout(entry, event.chunk);
          return;
        }
        if (event.type === "stderr" && event.chunk.trim())
          emitRuntime(entry, {
            kind: "stderr",
            eventType: "runtime.stderr",
            message: event.chunk.trim(),
            raw: event.chunk,
          });
      },
    },
    false,
  ).then(
    () => closeEntry(entry, "Cursor ACP runtime exited"),
    (error) => {
      const runtimeError =
        error instanceof Error ? error : new Error(String(error));
      rejectProcessId(runtimeError);
      closeEntry(entry, runtimeError.message);
    },
  );
  entry.readyPromise = (async () => {
    await entry.processIdPromise;
    await request(entry, "initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "cohub-local", version: "1.0.0" },
    }, STARTUP_REQUEST_TIMEOUT_MS);
    await notify(entry, "initialized");
    await request(
      entry,
      "authenticate",
      { methodId: "cursor_login" },
      STARTUP_REQUEST_TIMEOUT_MS,
    );
  })();
  void entry.readyPromise.catch((error) => {
    closeEntry(entry, error instanceof Error ? error.message : String(error));
  });
  runtimes.set(entry.key, entry);
  return entry;
}
function getOrCreateRuntime(input: {
  spaceId: string;
  sessionId: string;
  connection: SandboxConnection;
  accessMode: AccessMode;
  externalSessionId: string | null;
  environment: Record<string, string>;
  executionContextKey: string;
  model: string;
  thinkingLevel: string;
  writableRoots: readonly string[];
}) {
  const key = `${input.spaceId}:${input.sessionId}:${input.executionContextKey}:${input.model}:${input.thinkingLevel}:${localSpaceAccessKey(input.writableRoots)}`;
  const existing = runtimes.get(key);
  if (
    existing &&
    !existing.closed &&
    existing.connection.sandboxId === input.connection.sandboxId &&
    existing.accessMode === input.accessMode &&
    (!input.externalSessionId ||
      !existing.externalSessionId ||
      existing.externalSessionId === input.externalSessionId)
  ) {
    clearIdleTimer(existing);
    existing.lastUsedAt = Date.now();
    return { entry: existing, reused: true };
  }
  if (existing) closeEntry(existing, "Cursor runtime configuration changed");
  return {
    entry: createRuntime({
      key,
      spaceId: input.spaceId,
      cohubSessionId: input.sessionId,
      connection: input.connection,
      accessMode: input.accessMode,
      externalSessionId: input.externalSessionId,
      environment: input.environment,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      writableRoots: input.writableRoots,
    }),
    reused: false,
  };
}
async function ensureSession(entry: RuntimeEntry, model: string) {
  await entry.readyPromise;
  if (!entry.externalSessionId) {
    const result = entry.requestedSessionId
      ? await request(entry, "session/load", {
          sessionId: entry.requestedSessionId,
          cwd: entry.workspaceCwd,
          mcpServers: [],
        })
      : await request(entry, "session/new", {
          cwd: entry.workspaceCwd,
          mcpServers: [],
        });
    entry.externalSessionId =
      text(result.sessionId) || entry.requestedSessionId || null;
    if (!entry.externalSessionId)
      throw new Error("Cursor ACP did not return a session id");
  }
  if (entry.configuredModel !== model) {
    await request(entry, "session/set_config_option", {
      sessionId: entry.externalSessionId,
      configId: "model",
      value: model,
    });
    entry.configuredModel = model;
  }
  if (entry.configuredMode !== "agent") {
    await request(entry, "session/set_config_option", {
      sessionId: entry.externalSessionId,
      configId: "mode",
      value: "agent",
    });
    entry.configuredMode = "agent";
  }
  return entry.externalSessionId;
}

export async function runCursorAcpHarness(input: {
  spaceId: string;
  sessionId: string;
  turnId: string;
  prompt: string;
  environment: Record<string, string>;
  executionContextKey: string;
  externalSessionId: string | null;
  accessMode: AccessMode;
  model: string;
  thinkingLevel: string;
  writableRoots: readonly string[];
  abortSignal: AbortSignal;
  connection: SandboxConnection;
  onExternalSessionId?: (sessionId: string) => void;
  onProgress?: (progress: ExternalHarnessProgress) => void;
  reducer: HarnessEventReducer;
}): Promise<ExternalHarnessResult> {
  const startedAt = performance.now();
  const { entry, reused } = getOrCreateRuntime(input);
  if (entry.activeTurn)
    throw new Error("Cursor runtime already has an active turn");
  const externalSessionId = await ensureSession(entry, input.model);
  input.onExternalSessionId?.(externalSessionId);
  input.onProgress?.(
    input.reducer.pushRuntimeEvent({
      kind: "status",
      eventType: reused ? "runtime.reused" : "runtime.ready",
      message: reused ? "Reused warm Cursor runtime" : "Cursor runtime ready",
      raw: {
        reused,
        startupOverheadMs: Math.round(performance.now() - startedAt),
      },
    }),
  );
  return new Promise<ExternalHarnessResult>((resolve, reject) => {
    const active: ActiveTurn = {
      reducer: input.reducer,
      onProgress: input.onProgress,
      resolve,
      reject,
      abortRequested: input.abortSignal.aborted,
    };
    entry.activeTurn = active;
    entry.lastUsedAt = Date.now();
    flushPendingRuntimeEvents(entry);
    const abort = () => {
      active.abortRequested = true;
      void notify(entry, "session/cancel", { sessionId: externalSessionId });
    };
    input.abortSignal.addEventListener("abort", abort, { once: true });
    if (active.abortRequested) abort();
    const settle = (callback: () => void) => {
      input.abortSignal.removeEventListener("abort", abort);
      if (entry.activeTurn === active) entry.activeTurn = null;
      entry.lastUsedAt = Date.now();
      scheduleIdleClose(entry);
      callback();
    };
    active.resolve = (result) => settle(() => resolve(result));
    active.reject = (error) => settle(() => reject(error));
    void request(
      entry,
      "session/prompt",
      {
        sessionId: externalSessionId,
        prompt: [{ type: "text", text: input.prompt }],
      },
      PROMPT_TIMEOUT_MS,
    ).then(
      (response) => {
        if (
          active.abortRequested ||
          text(response.stopReason) === "cancelled"
        ) {
          active.reject(new Error("aborted"));
          return;
        }
        emit(entry, {
          type: "end",
          stopReason: response.stopReason,
          sessionId: externalSessionId,
        });
        try {
          active.resolve(active.reducer.result());
        } catch (error) {
          active.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      },
      (error) =>
        active.reject(
          error instanceof Error ? error : new Error(String(error)),
        ),
    );
  });
}

export function closeCursorAcpRuntimesForTests() {
  for (const entry of [...runtimes.values()]) closeEntry(entry, "test cleanup");
}
