#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import WebSocket from "ws";
import { compatibleFetch } from "./fetch.mjs";
import {
  executeRelayCommandUntilAvailable,
  RelayNodeError,
  resolveLocalAccessToken,
} from "./core.mjs";
import {
  createPulseWatcher,
  normalizePulseWatchEnvelope,
} from "./pulse-watch.mjs";
import { createTurnWatcher } from "./turn-watch.mjs";
import {
  assertRelayReadyCompatibility,
  RELAY_EVENT_SCHEMA_VERSION,
  RELAY_PROTOCOL_VERSION,
} from "./protocol-compat.mjs";
import { SerialCommandBuffer } from "./serial-command-buffer.mjs";

const PROTOCOL_VERSION = RELAY_PROTOCOL_VERSION;
const nodeId = process.env.COHUB_LOCAL_RELAY_NODE_ID?.trim() || "mac-mini";
const relayUrl = process.env.COHUB_LOCAL_RELAY_URL?.trim();
const localApiOrigin =
  process.env.COHUB_LOCAL_RELAY_API_ORIGIN?.trim() || "http://127.0.0.1:8787";
const localGatewayOrigin =
  process.env.COHUB_LOCAL_RELAY_GATEWAY_ORIGIN?.trim() ||
  "ws://127.0.0.1:8788/ws";
const cloudApiOrigin =
  process.env.PUBLIC_CLOUD_API_ORIGIN?.trim() || "https://api.cohub.live";
const cloudGatewayOrigin =
  process.env.PUBLIC_CLOUD_GATEWAY_ORIGIN?.trim() ||
  "wss://gateway.cohub.live/ws";
const spaceStorageRoot = process.env.SPACE_STORAGE_ROOT?.trim();
const heartbeatMs = Number(
  process.env.COHUB_LOCAL_RELAY_HEARTBEAT_MS?.trim() || "30000",
);
const maxResponseBytes = Number(
  process.env.COHUB_LOCAL_RELAY_MAX_RESPONSE_BYTES?.trim() || "2097152",
);
const maxAttachmentBytes = Number(
  process.env.COHUB_LOCAL_RELAY_ATTACHMENT_MAX_BYTES?.trim() || "104857600",
);
const commandTimeoutMs = Number(
  process.env.COHUB_LOCAL_RELAY_COMMAND_TIMEOUT_MS?.trim() || "60000",
);
const outcomeAckTimeoutMs = Number(
  process.env.COHUB_LOCAL_RELAY_OUTCOME_ACK_TIMEOUT_MS?.trim() ||
    String(Math.max(1_000, heartbeatMs * 2)),
);
const desktopInstanceSecret =
  process.env.COHUB_DESKTOP_INSTANCE_SECRET?.trim() || "";
const keychainService =
  process.env.COHUB_LOCAL_RELAY_KEYCHAIN_SERVICE?.trim() ||
  "Cohub Local Mode Relay Node";
const statusFile =
  process.env.COHUB_LOCAL_RELAY_STATUS_FILE?.trim() ||
  join(
    process.env.COHUB_LOCAL_DATA_DIR?.trim() ||
      join(homedir(), ".cohub-local-mode"),
    "relay-node-status.json",
  );

if (!relayUrl) throw new Error("COHUB_LOCAL_RELAY_URL is required");
if (!spaceStorageRoot) throw new Error("SPACE_STORAGE_ROOT is required");
if (!/^wss:\/\//i.test(relayUrl) && process.env.NODE_ENV === "production") {
  throw new Error("Production relay URL must use wss://");
}

const relayNodeBaseUrl = (() => {
  const value = new URL(relayUrl);
  value.protocol = value.protocol === "wss:" ? "https:" : "http:";
  value.pathname = value.pathname.replace(/\/connect\/?$/, "");
  value.search = "";
  value.hash = "";
  return value.toString().replace(/\/$/, "");
})();
for (const [name, value] of [
  ["COHUB_LOCAL_RELAY_HEARTBEAT_MS", heartbeatMs],
  ["COHUB_LOCAL_RELAY_MAX_RESPONSE_BYTES", maxResponseBytes],
  ["COHUB_LOCAL_RELAY_ATTACHMENT_MAX_BYTES", maxAttachmentBytes],
  ["COHUB_LOCAL_RELAY_COMMAND_TIMEOUT_MS", commandTimeoutMs],
  ["COHUB_LOCAL_RELAY_OUTCOME_ACK_TIMEOUT_MS", outcomeAckTimeoutMs],
]) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function readNodeToken() {
  const fromEnvironment = process.env.COHUB_LOCAL_RELAY_NODE_TOKEN?.trim();
  if (fromEnvironment) return fromEnvironment;
  if (process.platform !== "darwin") {
    throw new Error(
      "COHUB_LOCAL_RELAY_NODE_TOKEN is required outside macOS",
    );
  }
  try {
    return execFileSync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-w",
        "-s",
        keychainService,
        "-a",
        nodeId,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch (error) {
    throw new Error(
      `Relay node token is missing from Keychain service ${keychainService} for ${nodeId}`,
      { cause: error },
    );
  }
}

const nodeToken = readNodeToken();

const dataDir =
  process.env.COHUB_LOCAL_DATA_DIR?.trim() ||
  join(homedir(), ".cohub-local-mode");

let socket = null;
let readyAccepted = false;
let stopping = false;
let reconnectAttempt = 0;
let reconnectTimer = null;
let mutationState = null;
const readStates = new Map();
const deferredCommands = new SerialCommandBuffer();
const deferredMutationIds = new Set();
const deferredReads = new Map();
let statusWrite = Promise.resolve();
let activityWatchUpdate = Promise.resolve();
let statusHeartbeat = null;

const TERMINAL_COMMAND_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

const localApiOriginUrl = new URL(localApiOrigin);

function relayFetcher(input, init = {}) {
  if (!desktopInstanceSecret) return compatibleFetch(input, init);
  let target;
  try {
    target = new URL(
      typeof input === "string" ? input : input?.url ?? String(input),
    );
  } catch {
    return compatibleFetch(input, init);
  }
  if (target.origin !== localApiOriginUrl.origin) {
    const headers = new Headers(init.headers ?? input?.headers);
    if (headers.has("x-cohub-desktop-secret")) {
      headers.delete("x-cohub-desktop-secret");
      return compatibleFetch(input, { ...init, headers });
    }
    return compatibleFetch(input, init);
  }
  const headers = new Headers(init.headers ?? input?.headers);
  headers.set("x-cohub-desktop-secret", desktopInstanceSecret);
  // Do not let node-fetch carry the instance secret through a cross-origin
  // redirect. The API's local endpoints never need redirect following.
  return compatibleFetch(input, { ...init, headers, redirect: "manual" });
}

const watcher = createTurnWatcher({
  dataDir,
  localApiOrigin,
  spaceStorageRoot,
  relayNodeBaseUrl,
  relayNodeToken: nodeToken,
  maxAttachmentBytes,
  nodeId,
  fetcher: relayFetcher,
  onEvent: (event) => {
    send({ type: "turn-event", event });
  },
});
await watcher.start();

const pulseWatcher = createPulseWatcher({
  dataDir,
  nodeId,
  originConfigs: {
    local: { apiOrigin: localApiOrigin, gatewayOrigin: localGatewayOrigin },
    cloud: { apiOrigin: cloudApiOrigin, gatewayOrigin: cloudGatewayOrigin },
  },
  fetcher: relayFetcher,
  getAccessToken: (forceRefresh = false) =>
    resolveLocalAccessToken(relayFetcher, localApiOrigin, undefined, { forceRefresh }),
  onEvent: (event) => {
    send({ type: "turn-event", event });
  },
  onError: (error) => {
    const code =
      error && typeof error === "object" && "name" in error
        ? String(error.name)
        : "PulseCollectorError";
    console.error(
      `[relay-node] pulse collector ${code}: ${error instanceof Error ? error.message : String(error)}`,
    );
  },
});
await pulseWatcher.start();

function writeStatus(state, details = {}) {
  const payload = {
    protocolVersion: PROTOCOL_VERSION,
    eventSchemaVersion: RELAY_EVENT_SCHEMA_VERSION,
    nodeId,
    state,
    pid: process.pid,
    relayHost: new URL(relayUrl).host,
    updatedAt: new Date().toISOString(),
    ...details,
  };
  if (typeof process.send === "function") {
    try {
      process.send({ type: "relay-status", ...payload }, (error) => {
        if (error) {
          console.error(`[relay-node] failed to send IPC status: ${error.message}`);
        }
      });
    } catch (error) {
      console.error(
        `[relay-node] failed to send IPC status: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  statusWrite = statusWrite
    .then(async () => {
      await mkdir(dirname(statusFile), { recursive: true });
      const temporary = `${statusFile}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, statusFile);
    })
    .catch((error) => {
      console.error(`[relay-node] failed to write status: ${error.message}`);
    });
}

function send(message) {
  if (!readyAccepted || !socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...message }));
    return true;
  } catch (error) {
    console.error(
      `[relay-node] failed to send ${message.type ?? "message"}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

function connectionState() {
  if (stopping) return "stopping";
  if (
    !socket ||
    socket.readyState === WebSocket.CLOSED ||
    socket.readyState === WebSocket.CLOSING
  ) {
    return "disconnected";
  }
  if (socket.readyState === WebSocket.OPEN && readyAccepted) return "connected";
  return "connecting";
}

const MAX_READ_COMMANDS = 4;
const COMMAND_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function commandLane(command) {
  return command?.request?.method === "GET" ? "read" : "mutation";
}

function isExecutableCommand(command) {
  if (!command || typeof command !== "object" || Array.isArray(command)) return false;
  if (typeof command.id !== "string" || !command.id) return false;
  if (command.status !== "queued") return false;
  const request = command.request;
  return Boolean(
    request &&
      typeof request === "object" &&
      !Array.isArray(request) &&
      COMMAND_METHODS.has(request.method) &&
      typeof request.path === "string" &&
      request.path.startsWith("/") &&
      typeof request.body === "string",
  );
}

function activeState(commandId) {
  if (mutationState?.command.id === commandId) return mutationState;
  return readStates.get(commandId) ?? null;
}

function stateIsActive(state) {
  return state && activeState(state.command.id) === state;
}

function allActiveStates() {
  return mutationState ? [mutationState, ...readStates.values()] : [...readStates.values()];
}

function stopHeartbeat(state) {
  if (!state?.heartbeat) return;
  clearInterval(state.heartbeat);
  state.heartbeat = null;
}

function stopAckTimer(state) {
  if (!state?.ackTimer) return;
  clearTimeout(state.ackTimer);
  state.ackTimer = null;
  state.ackKind = null;
}

function armAckTimer(state, kind) {
  if (!state || !stateIsActive(state)) return;
  stopAckTimer(state);
  state.ackKind = kind;
  state.ackTimer = setTimeout(() => {
    state.ackTimer = null;
    if (!stateIsActive(state) || state.ackKind !== kind) return;
    state.ackKind = null;
    const commandId = state.command.id;
    const detail = {
      commandId,
      attempt: state.attempt,
      lastErrorCode: `${kind}_ack_timeout`,
    };
    console.error(
      `[relay-node] ${kind} acknowledgement timed out for command ${commandId}`,
    );
    writeStatus("disconnected", detail);
    if (socket &&
        (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close(4008, `${kind} acknowledgement timeout`);
    } else {
      scheduleReconnect();
    }
  }, outcomeAckTimeoutMs);
  state.ackTimer.unref?.();
}

function sendClaim(state) {
  if (!state || !stateIsActive(state)) return false;
  const sent = send({ type: "claim", commandId: state.command.id });
  if (sent) armAckTimer(state, "claim");
  else scheduleReconnect();
  return sent;
}

function ensureHeartbeat(state) {
  if (!state || !stateIsActive(state) || state.outcome || state.heartbeat) return;
  state.heartbeat = setInterval(() => {
    if (!stateIsActive(state) || state.attempt === null || state.outcome) return;
    send({
      type: "heartbeat",
      commandId: state.command.id,
      attempt: state.attempt,
    });
  }, heartbeatMs);
  state.heartbeat.unref?.();
}

function sendStarted(state) {
  if (!state || !stateIsActive(state) || state.attempt === null || state.outcome) return false;
  const sent = send({
    type: "started",
    commandId: state.command.id,
    attempt: state.attempt,
  });
  ensureHeartbeat(state);
  if (!sent) scheduleReconnect();
  return sent;
}

function activateCommand(command) {
  if (!isExecutableCommand(command)) return false;
  const lane = commandLane(command);
  if (lane === "mutation" && mutationState) return false;
  if (lane === "read" && readStates.size >= MAX_READ_COMMANDS) return false;
  const state = {
    command,
    lane,
    attempt: null,
    heartbeat: null,
    ackTimer: null,
    ackKind: null,
    outcome: null,
    abort: new AbortController(),
  };
  if (lane === "mutation") mutationState = state;
  else readStates.set(command.id, state);
  if (sendClaim(state)) return true;
  detachState(state, { abort: false });
  deferCommand(command);
  return false;
}

function deferCommand(command) {
  const lane = commandLane(command);
  if (lane === "read") {
    if (!deferredReads.has(command.id)) deferredReads.set(command.id, command);
    return;
  }
  if (deferredMutationIds.has(command.id)) return;
  const result = deferredCommands.defer(command, null);
  if (result === "queued") deferredMutationIds.add(command.id);
}

function removeDeferredCommand(commandId) {
  deferredReads.delete(commandId);
  if (deferredMutationIds.delete(commandId)) deferredCommands.delete(commandId);
}

function drainDeferredCommand() {
  if (
    !readyAccepted ||
    !socket ||
    socket.readyState !== WebSocket.OPEN
  ) return;
  let progressed = true;
  while (progressed) {
    progressed = false;
    if (!mutationState) {
      const command = deferredCommands.shift();
      if (command) {
        deferredMutationIds.delete(command.id);
        if (!activateCommand(command)) return;
        progressed = true;
      }
    }
    while (readStates.size < MAX_READ_COMMANDS) {
      const entry = deferredReads.entries().next();
      if (entry.done) break;
      const [commandId, command] = entry.value;
      deferredReads.delete(commandId);
      if (!activateCommand(command)) {
        deferredReads.set(commandId, command);
        return;
      }
      progressed = true;
    }
  }
}

function detachState(state, { abort = true } = {}) {
  if (!state || !stateIsActive(state)) return false;
  stopHeartbeat(state);
  stopAckTimer(state);
  if (abort) {
    state?.abort.abort(new DOMException("Relay command stopped", "AbortError"));
  }
  if (state.lane === "mutation") mutationState = null;
  else readStates.delete(state.command.id);
  removeDeferredCommand(state.command.id);
  return true;
}

function clearState(state, { abort = true } = {}) {
  detachState(state, { abort });
  queueMicrotask(drainDeferredCommand);
}

function clearAllStates() {
  for (const state of allActiveStates()) detachState(state);
  deferredReads.clear();
  deferredMutationIds.clear();
}

function enqueueCommand(command) {
  if (!isExecutableCommand(command)) {
    console.error("[relay-node] relay sent an invalid command; execution skipped");
    return;
  }
  if (
    activeState(command.id) ||
    deferredReads.has(command.id) ||
    deferredMutationIds.has(command.id)
  ) {
    return;
  }
  deferCommand(command);
  queueMicrotask(drainDeferredCommand);
}

function sendOutcome(state, outcome) {
  if (!stateIsActive(state)) return false;
  state.outcome = outcome;
  stopHeartbeat(state);
  const sent = send(outcome);
  if (sent) {
    armAckTimer(state, "outcome");
  } else if (!sent) {
    scheduleReconnect();
  }
  return sent;
}

function resumeActiveCommands() {
  for (const state of allActiveStates()) {
    if (state.outcome) sendOutcome(state, state.outcome);
    else if (state.attempt !== null) sendStarted(state);
    else sendClaim(state);
  }
}

async function runClaimedCommand(state, attempt) {
  if (!stateIsActive(state) || state.attempt !== null || !Number.isInteger(attempt) || attempt < 1) return;
  state.attempt = attempt;
  stopAckTimer(state);
  writeStatus("executing", {
    commandId: state.command.id,
    attempt,
    commandStatus: "claimed",
  });
  sendStarted(state);
  try {
    const { result, watch } = await executeRelayCommandUntilAvailable(state.command, {
      fetcher: relayFetcher,
      localApiOrigin,
      maxResponseBytes,
      requestTimeoutMs: commandTimeoutMs,
      relayNodeBaseUrl,
      relayNodeToken: nodeToken,
      spaceStorageRoot,
      signal: state.abort.signal,
      onRetry: ({ code, retryDelayMs }) => {
        console.warn(
          `[relay-node] ${code}; retrying command ${state.command.id} in ${retryDelayMs}ms`,
        );
        writeStatus("waiting-for-local-api", {
          commandId: state.command.id,
          attempt,
          lastErrorCode: code,
          retryDelayMs,
        });
      },
    });
    if (state.abort.signal.aborted || !stateIsActive(state)) return;
    const outcome = {
      type: "result",
      commandId: state.command.id,
      attempt,
      result,
    };
    sendOutcome(state, outcome);
    if (watch) {
      void watcher.watch({
        eventId: randomUUID(),
        nodeId: state.command.nodeId ?? nodeId,
        ...watch,
      });
    }
    writeStatus(connectionState(), {
      lastCommandId: state.command.id,
      lastCommandStatus:
        result.status >= 200 && result.status < 300 ? "succeeded" : "failed",
    });
  } catch (error) {
    if (state.abort.signal.aborted || !stateIsActive(state)) return;
    const code =
      error instanceof RelayNodeError ? error.code : "node_execution_failed";
    const message = error instanceof Error ? error.message : String(error);
    const outcome = {
      type: "failed",
      commandId: state.command.id,
      attempt,
      code,
      message,
    };
    sendOutcome(state, outcome);
    writeStatus(connectionState(), {
      lastCommandId: state.command.id,
      lastCommandStatus: "failed",
      lastErrorCode: code,
    });
  }
}

function handleMessage(raw, sourceSocket = socket) {
  if (sourceSocket && sourceSocket !== socket) return;
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    console.error("[relay-node] relay sent invalid JSON");
    readyAccepted = false;
    socket?.close(1002, "invalid relay message");
    return;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    console.error("[relay-node] relay sent an invalid message");
    readyAccepted = false;
    socket?.close(1002, "invalid relay message");
    return;
  }
  if (message.protocolVersion !== PROTOCOL_VERSION) {
    console.error("[relay-node] relay protocol mismatch");
    readyAccepted = false;
    socket?.close(1002, "relay protocol mismatch");
    return;
  }
  if (message.type === "ready") {
    try {
      assertRelayReadyCompatibility(message);
      if (message.nodeId !== nodeId) {
        throw new Error(
          `relay node mismatch: expected ${nodeId}, got ${message.nodeId ?? "missing"}`,
        );
      }
    } catch (error) {
      readyAccepted = false;
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[relay-node] ${detail}`);
      writeStatus("incompatible", {
        lastErrorCode: "relay_event_schema_mismatch",
        lastErrorMessage: detail,
      });
      socket?.close(1002, "relay event schema mismatch");
      return;
    }
    readyAccepted = true;
    console.log(`[relay-node] connected as ${message.nodeId}`);
    writeStatus("connected");
    resumeActiveCommands();
    watcher.flushPending();
    pulseWatcher.flushPending();
    drainDeferredCommand();
    return;
  }
  if (message.type === "turn-event-ack" && typeof message.eventId === "string") {
    void Promise.all([
      watcher.ack(message.eventId),
      pulseWatcher.ack(message.eventId),
    ]);
    return;
  }
  if (message.type === "activity-watch.replace") {
    let replacement;
    try {
      replacement = normalizePulseWatchEnvelope(message);
    } catch (error) {
      console.error(
        `[relay-node] ${error instanceof Error ? error.message : String(error)}`,
      );
      readyAccepted = false;
      writeStatus("incompatible", {
        lastErrorCode: "invalid_activity_watch_replacement",
        lastErrorMessage: error instanceof Error ? error.message : String(error),
      });
      socket?.close(1002, "invalid Activity watch replacement");
      return;
    }
    activityWatchUpdate = activityWatchUpdate
      .then(async () => {
        await pulseWatcher.replaceWatch(replacement);
        send({
          type: "activity-watch.ack",
          revision: replacement.revision,
          digest: replacement.digest,
        });
      })
      .catch((error) => {
        console.error(
          `[relay-node] Activity watch replacement failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    return;
  }
  if (message.type === "command") {
    enqueueCommand(message.command);
    return;
  }
  if (
    message.type === "claimed" &&
    typeof message.commandId === "string" &&
    Number.isInteger(message.attempt) &&
    message.attempt > 0
  ) {
    const state = activeState(message.commandId);
    if (!state || state.attempt !== null) return;
    stopAckTimer(state);
    void runClaimedCommand(state, message.attempt);
    return;
  }
  if (message.type === "ack") {
    if (!TERMINAL_COMMAND_STATUSES.has(message.status)) return;
    const state = activeState(message.commandId);
    // The relay's terminal record is authoritative. A command may be
    // cancelled or failed after the node has already sent its outcome.
    removeDeferredCommand(message.commandId);
    if (state) clearState(state, { abort: false });
    return;
  }
  if (message.type === "error") {
    console.error(
      `[relay-node] ${message.code ?? "relay_error"}: ${message.message ?? "unknown relay error"}`,
    );
    if (message.code === "stale_attempt") {
      const state = typeof message.commandId === "string"
        ? activeState(message.commandId)
        : null;
      if (state) clearState(state);
      return;
    }
    const state = typeof message.commandId === "string"
      ? activeState(message.commandId)
      : null;
    if (
      message.code === "command_already_claimed" &&
      state &&
      state.attempt === null
    ) {
      console.error(
        `[relay-node] command ${message.commandId} is already claimed; waiting for lease recovery`,
      );
      armAckTimer(state, "claim");
      return;
    }
    if (state) clearState(state);
  }
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;
  const delay = Math.min(30_000, 500 * 2 ** Math.min(reconnectAttempt, 6));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay + Math.floor(Math.random() * 250));
}

function connect() {
  if (stopping) return;
  readyAccepted = false;
  writeStatus("connecting");
  const next = new WebSocket(relayUrl, {
    headers: { authorization: `Bearer ${nodeToken}` },
    handshakeTimeout: 15_000,
  });
  socket = next;
  next.on("open", () => {
    reconnectAttempt = 0;
  });
  next.on("message", (raw) => handleMessage(raw, next));
  next.on("error", (error) => {
    if (socket === next) {
      readyAccepted = false;
      writeStatus("disconnected", {
        lastErrorCode: "relay_socket_error",
        lastErrorMessage: error.message,
      });
    }
    console.error(`[relay-node] connection error: ${error.message}`);
  });
  next.on("close", (code, reason) => {
    if (socket !== next) return;
    readyAccepted = false;
    socket = null;
    console.error(
      `[relay-node] disconnected (${code}${reason.length ? `: ${reason.toString()}` : ""})`,
    );
    writeStatus("disconnected", { closeCode: code });
    scheduleReconnect();
  });
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  writeStatus("stopping");
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (statusHeartbeat) clearInterval(statusHeartbeat);
  clearAllStates();
  socket?.close(1000, "node shutting down");
  const forcedExit = setTimeout(() => process.exit(1), 5_000);
  forcedExit.unref();
  await activityWatchUpdate.catch(() => {});
  await Promise.all([watcher.stop(), pulseWatcher.stop(), statusWrite]).catch((error) => {
    console.error(
      `[relay-node] shutdown persistence failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  clearTimeout(forcedExit);
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
statusHeartbeat = setInterval(() => writeStatus(connectionState()), 15_000);
statusHeartbeat.unref?.();
connect();
