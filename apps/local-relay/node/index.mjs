#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import WebSocket from "ws";
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
let stopping = false;
let reconnectAttempt = 0;
let reconnectTimer = null;
let current = null;
let pendingOutcome = null;
let statusWrite = Promise.resolve();
let activityWatchUpdate = Promise.resolve();

const watcher = createTurnWatcher({
  dataDir,
  localApiOrigin,
  spaceStorageRoot,
  relayNodeBaseUrl,
  relayNodeToken: nodeToken,
  maxAttachmentBytes,
  nodeId,
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
  getAccessToken: (forceRefresh = false) =>
    resolveLocalAccessToken(fetch, localApiOrigin, undefined, { forceRefresh }),
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
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...message }));
  return true;
}

function clearCurrent({ abort = true } = {}) {
  if (current?.heartbeat) clearInterval(current.heartbeat);
  if (abort) {
    current?.abort.abort(new DOMException("Relay command stopped", "AbortError"));
  }
  current = null;
}

function sendOutcome(outcome) {
  if (send(outcome)) {
    pendingOutcome = null;
    return true;
  }
  pendingOutcome = outcome;
  return false;
}

async function runClaimedCommand(attempt) {
  const state = current;
  if (!state || state.attempt !== null) return;
  state.attempt = attempt;
  writeStatus("executing", {
    commandId: state.command.id,
    attempt,
    commandStatus: "claimed",
  });
  send({ type: "started", commandId: state.command.id, attempt });
  state.heartbeat = setInterval(() => {
    send({
      type: "heartbeat",
      commandId: state.command.id,
      attempt,
    });
  }, heartbeatMs);
  try {
    const { result, watch } = await executeRelayCommandUntilAvailable(state.command, {
      localApiOrigin,
      maxAttachmentBytes,
      maxResponseBytes,
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
    if (state.abort.signal.aborted || current !== state) return;
    sendOutcome({
      type: "result",
      commandId: state.command.id,
      attempt,
      result,
    });
    if (watch) {
      void watcher.watch({
        eventId: randomUUID(),
        nodeId: state.command.nodeId ?? nodeId,
        ...watch,
      });
    }
    writeStatus("connected", {
      lastCommandId: state.command.id,
      lastCommandStatus:
        result.status >= 200 && result.status < 300 ? "succeeded" : "failed",
    });
  } catch (error) {
    if (state.abort.signal.aborted || current !== state) return;
    const code =
      error instanceof RelayNodeError ? error.code : "node_execution_failed";
    const message = error instanceof Error ? error.message : String(error);
    sendOutcome({
      type: "failed",
      commandId: state.command.id,
      attempt,
      code,
      message,
    });
    writeStatus("connected", {
      lastCommandId: state.command.id,
      lastCommandStatus: "failed",
      lastErrorCode: code,
    });
  } finally {
    if (current === state) clearCurrent({ abort: false });
  }
}

function handleMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    console.error("[relay-node] relay sent invalid JSON");
    socket?.close(1002, "invalid relay message");
    return;
  }
  if (message.protocolVersion !== PROTOCOL_VERSION) {
    console.error("[relay-node] relay protocol mismatch");
    socket?.close(1002, "relay protocol mismatch");
    return;
  }
  if (message.type === "ready") {
    try {
      assertRelayReadyCompatibility(message);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[relay-node] ${detail}`);
      writeStatus("incompatible", {
        lastErrorCode: "relay_event_schema_mismatch",
        lastErrorMessage: detail,
      });
      socket?.close(1002, "relay event schema mismatch");
      return;
    }
    console.log(`[relay-node] connected as ${message.nodeId}`);
    writeStatus("connected");
    if (pendingOutcome) sendOutcome(pendingOutcome);
    watcher.flushPending();
    pulseWatcher.flushPending();
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
    if (current) {
      if (current.command.id === message.command?.id) return;
      console.error(
        `[relay-node] rejected concurrent command ${message.command?.id ?? "unknown"}`,
      );
      return;
    }
    current = {
      command: message.command,
      attempt: null,
      heartbeat: null,
      abort: new AbortController(),
    };
    send({ type: "claim", commandId: message.command.id });
    return;
  }
  if (
    message.type === "claimed" &&
    current?.command.id === message.commandId &&
    current.attempt === null
  ) {
    void runClaimedCommand(message.attempt);
    return;
  }
  if (message.type === "error") {
    console.error(
      `[relay-node] ${message.code ?? "relay_error"}: ${message.message ?? "unknown relay error"}`,
    );
    if (message.code === "stale_attempt") {
      if (pendingOutcome?.commandId === message.commandId) pendingOutcome = null;
      if (message.commandId && current?.command.id === message.commandId) {
        clearCurrent();
      }
      return;
    }
    if (message.commandId && current?.command.id === message.commandId) {
      clearCurrent();
    }
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
  writeStatus("connecting");
  const next = new WebSocket(relayUrl, {
    headers: { authorization: `Bearer ${nodeToken}` },
    handshakeTimeout: 15_000,
  });
  socket = next;
  next.on("open", () => {
    reconnectAttempt = 0;
  });
  next.on("message", handleMessage);
  next.on("error", (error) => {
    console.error(`[relay-node] connection error: ${error.message}`);
  });
  next.on("close", (code, reason) => {
    if (socket === next) socket = null;
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
  clearCurrent();
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
connect();
