import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import {
  RELAY_EVENT_SCHEMA_VERSION,
  RELAY_PROTOCOL_VERSION,
} from "./protocol-compat.mjs";

const REPO_ROOT = join(import.meta.dirname, "../../..");
const INDEX_PATH = join(REPO_ROOT, "apps/local-relay/node/index.mjs");
const SPACE_ID = "2f4cb274-7f80-4a4b-b326-22d4af6a9873";

function jsonResponse(response, value, status = 200) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
  });
  response.end(body);
}

function waitFor(predicate, timeoutMs = 4_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        const value = predicate();
        if (value) {
          resolve(value);
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("Timed out waiting for relay node event"));
        return;
      }
      setTimeout(check, 10).unref();
    };
    check();
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 500)),
  ]);
}

async function closeServer(server) {
  for (const client of server.clients) client.terminate();
  await new Promise((resolve) => server.close(resolve));
}

async function startScenario(
  t,
  {
    reconnectAfterResult = false,
    duplicateDeliveryAfterResult = false,
    queueSecond = false,
    timeoutCommand = false,
    commandTimeoutMs = 2_000,
    disconnectBeforeClaimAck = false,
    sendReady = true,
    parallelRead = false,
  } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), "cohub-relay-command-test-"));
  const spaceStorageRoot = await mkdtemp(join(tmpdir(), "cohub-relay-space-test-"));
  t.after(() => Promise.all([
    rm(dataDir, { recursive: true, force: true }),
    rm(spaceStorageRoot, { recursive: true, force: true }),
  ]));

  let promptCalls = 0;
  const desktopSecrets = [];
  const localApi = createServer(async (request, response) => {
    desktopSecrets.push(request.headers["x-cohub-desktop-secret"] ?? null);
    if (request.url === "/api/local-mode/auth") {
      jsonResponse(response, { accessToken: "test-access-token" });
      return;
    }
    if (request.url === `/api/spaces/${SPACE_ID}/prompt`) {
      promptCalls += 1;
      if (timeoutCommand) {
        await new Promise((resolve) => request.once("close", resolve));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
      jsonResponse(response, { mode: "immediate", ok: true }, 202);
      return;
    }
    if (request.url === `/api/spaces/${SPACE_ID}/state`) {
      jsonResponse(response, { state: "ready" });
      return;
    }
    jsonResponse(response, { code: "not_found" }, 404);
  });
  const localPort = await listen(localApi);

  const relay = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve, reject) => {
    relay.once("listening", resolve);
    relay.once("error", reject);
  });
  const relayPort = relay.address().port;

  const command = {
    id: "relay-command-test-1",
    nodeId: "test-node",
    sequence: 1,
    idempotencyKey: "relay-idempotency-test-1",
    request: {
      method: "POST",
      path: `/api/spaces/${SPACE_ID}/prompt`,
      headers: {},
      body: JSON.stringify({
        sessionId: "f91aa9e1-a16c-4bbc-8154-a7ba0f30ef02",
        createSession: true,
        clientMessageId: "relay-idempotency-test-1",
        content: [{ type: "text", text: "hello" }],
      }),
    },
    attachments: [],
    status: "queued",
    attempt: 0,
    acceptedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    claimedAt: null,
    leaseExpiresAt: null,
    startedAt: null,
    completedAt: null,
    result: null,
    errorCode: null,
    errorMessage: null,
  };
  const secondCommand = {
    ...command,
    id: "relay-command-test-2",
    sequence: 2,
    idempotencyKey: "relay-idempotency-test-2",
    request: {
      ...command.request,
      body: command.request.body.replace("hello", "second command"),
    },
  };
  const readCommand = {
    ...command,
    id: "relay-command-test-read-1",
    sequence: 3,
    idempotencyKey: "relay-idempotency-test-read-1",
    request: {
      method: "GET",
      path: `/api/spaces/${SPACE_ID}/state`,
      headers: {},
      body: "",
    },
  };
  const deliveredCommands = parallelRead
    ? [command, readCommand]
    : [command];

  const frames = [];
  let firstResultSocket = null;
  let connectionCount = 0;
  let commandSent = false;
  let secondCommandSent = false;
  let claimCount = 0;
  relay.on("connection", (client) => {
    connectionCount += 1;
    const connection = connectionCount;
    if (sendReady) {
      client.send(JSON.stringify({
        protocolVersion: RELAY_PROTOCOL_VERSION,
        type: "ready",
        nodeId: "test-node",
        eventSchemaVersion: RELAY_EVENT_SCHEMA_VERSION,
      }));
    }
    client.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      frames.push({ connection, ...frame });
      const claimedCommand = [command, secondCommand, readCommand].find(
        (item) => item.id === frame.commandId,
      );
      if (frame.type === "claim" && claimedCommand) {
        claimCount += 1;
        if (disconnectBeforeClaimAck && claimCount === 1) {
          client.close(1000, "test reconnect before claim acknowledgement");
          return;
        }
        client.send(JSON.stringify({
          protocolVersion: RELAY_PROTOCOL_VERSION,
          type: "claimed",
          commandId: claimedCommand.id,
          attempt: 1,
          leaseExpiresAt: new Date(Date.now() + 10_000).toISOString(),
        }));
        return;
      }
      if (frame.type === "started" && claimedCommand) {
        const runningAck = JSON.stringify({
          protocolVersion: RELAY_PROTOCOL_VERSION,
          type: "ack",
          commandId: claimedCommand.id,
          status: "running",
        });
        setTimeout(() => client.send(runningAck), 10).unref();
        setTimeout(() => client.send(runningAck), 25).unref();
        return;
      }
      if (frame.type === "result" && claimedCommand) {
        if (!firstResultSocket) firstResultSocket = client;
        if (
          reconnectAfterResult &&
          claimedCommand.id === command.id &&
          client === firstResultSocket
        ) {
          if (duplicateDeliveryAfterResult) {
            client.send(JSON.stringify({
              protocolVersion: RELAY_PROTOCOL_VERSION,
              type: "command",
              command,
            }));
          }
          client.close(1000, "test reconnect before terminal acknowledgement");
          return;
        }
        if (duplicateDeliveryAfterResult && claimedCommand.id === command.id) {
          client.send(JSON.stringify({
            protocolVersion: RELAY_PROTOCOL_VERSION,
            type: "command",
            command,
          }));
        }
        if (queueSecond && claimedCommand.id === command.id && !secondCommandSent) {
          secondCommandSent = true;
          client.send(JSON.stringify({
            protocolVersion: RELAY_PROTOCOL_VERSION,
            type: "command",
            command: secondCommand,
          }));
          setTimeout(() => {
            client.send(JSON.stringify({
              protocolVersion: RELAY_PROTOCOL_VERSION,
              type: "ack",
              commandId: command.id,
              status: "succeeded",
            }));
          }, 35).unref();
          return;
        }
        client.send(JSON.stringify({
          protocolVersion: RELAY_PROTOCOL_VERSION,
          type: "ack",
          commandId: claimedCommand.id,
          status: "succeeded",
        }));
      }
    });
    if (sendReady && !commandSent) {
      commandSent = true;
      for (const deliveredCommand of deliveredCommands) {
        client.send(JSON.stringify({
          protocolVersion: RELAY_PROTOCOL_VERSION,
          type: "command",
          command: deliveredCommand,
        }));
      }
    }
  });

  const output = [];
  const errors = [];
  const ipcStatuses = [];
  const child = fork(INDEX_PATH, [], {
    cwd: REPO_ROOT,
    execArgv: [],
    env: {
      ...process.env,
      NODE_ENV: "test",
      COHUB_LOCAL_RELAY_URL: `ws://127.0.0.1:${relayPort}/connect`,
      COHUB_LOCAL_RELAY_NODE_ID: "test-node",
      COHUB_LOCAL_RELAY_NODE_TOKEN: "test-node-token",
      COHUB_LOCAL_RELAY_API_ORIGIN: `http://127.0.0.1:${localPort}`,
      COHUB_LOCAL_RELAY_HEARTBEAT_MS: "50",
      COHUB_LOCAL_RELAY_COMMAND_TIMEOUT_MS: String(commandTimeoutMs),
      COHUB_DESKTOP_INSTANCE_SECRET: "test-desktop-secret",
      COHUB_LOCAL_DATA_DIR: dataDir,
      COHUB_LOCAL_RELAY_STATUS_FILE: join(dataDir, "relay-status.json"),
      SPACE_STORAGE_ROOT: spaceStorageRoot,
    },
    silent: true,
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => errors.push(chunk.toString()));
  child.on("message", (message) => {
    if (message?.type === "relay-status") ipcStatuses.push(message);
  });
  t.after(async () => {
    await stopChild(child);
    await closeServer(relay);
    await new Promise((resolve) => localApi.close(resolve));
  });

  return {
    child,
    command,
    readCommand,
    frames,
    get connectionCount() { return connectionCount; },
    get promptCalls() { return promptCalls; },
    get claimCount() { return claimCount; },
    desktopSecrets,
    ipcStatuses,
    output,
    errors,
  };
}

test("runs an independent GET while a mutation remains blocked", async (t) => {
  const scenario = await startScenario(t, { parallelRead: true, timeoutCommand: true });
  await waitFor(
    () => scenario.frames.some(
      (frame) => frame.type === "result" && frame.commandId === scenario.readCommand.id,
    ),
    10_000,
  ).catch((error) => {
    error.message += `\nstdout: ${scenario.output.join("")}\nstderr: ${scenario.errors.join("")}\nframes: ${JSON.stringify(scenario.frames)}`;
    throw error;
  });
  assert.equal(scenario.promptCalls, 1);
  assert.equal(
    scenario.frames.some(
      (frame) => frame.type === "failed" && frame.commandId === scenario.command.id,
    ),
    false,
  );
});

test("does not report a WebSocket as connected before a matching ready message", async (t) => {
  const scenario = await startScenario(t, { sendReady: false });
  await waitFor(() => scenario.ipcStatuses.length > 0, 10_000);
  assert.equal(
    scenario.ipcStatuses.some((status) => status.state === "connected"),
    false,
  );
  assert.ok(scenario.ipcStatuses.some((status) => status.state === "connecting"));
  assert.ok(scenario.ipcStatuses.every((status) => status.nodeId === "test-node"));
});

test("keeps the real result after delayed and duplicate nonterminal acknowledgements", async (t) => {
  const scenario = await startScenario(t);
  await waitFor(() => scenario.frames.some((frame) => frame.type === "result"), 10_000);
  assert.equal(scenario.promptCalls, 1);
  assert.deepEqual(scenario.desktopSecrets, ["test-desktop-secret", "test-desktop-secret"]);
  assert.equal(
    scenario.frames.filter((frame) => frame.type === "result").length,
    1,
  );
  assert.equal(scenario.frames.filter((frame) => frame.type === "started").length, 1);
});

test("does not execute a duplicate delivery and waits for terminal acknowledgement before draining", async (t) => {
  const scenario = await startScenario(t, {
    duplicateDeliveryAfterResult: true,
    queueSecond: true,
  });
  await waitFor(
    () => scenario.frames.filter((frame) => frame.type === "result").length >= 2,
    10_000,
  ).catch((error) => {
    error.message += `\nstdout: ${scenario.output.join("")}\nstderr: ${scenario.errors.join("")}\nframes: ${JSON.stringify(scenario.frames)}`;
    throw error;
  });
  assert.equal(scenario.promptCalls, 2);
  const resultFrames = scenario.frames.filter((frame) => frame.type === "result");
  const claimFrames = scenario.frames.filter((frame) => frame.type === "claim");
  assert.equal(resultFrames[0].commandId, "relay-command-test-1");
  assert.equal(resultFrames[1].commandId, "relay-command-test-2");
  assert.equal(claimFrames.length, 2);
  assert.ok(
    scenario.frames.indexOf(claimFrames[1]) > scenario.frames.indexOf(resultFrames[0]),
  );
});

test("reclaims after a disconnect without executing before claim confirmation", async (t) => {
  const scenario = await startScenario(t, { disconnectBeforeClaimAck: true });
  await waitFor(
    () => scenario.frames.some((frame) => frame.type === "started") && scenario.promptCalls === 1,
    10_000,
  );
  assert.equal(scenario.claimCount, 2);
  assert.equal(scenario.promptCalls, 1);
  assert.equal(scenario.frames.filter((frame) => frame.type === "started").length, 1);
});

test("resends a pending result after reconnect without re-executing the command", async (t) => {
  const scenario = await startScenario(t, { reconnectAfterResult: true });
  await waitFor(
    () => scenario.frames.filter((frame) => frame.type === "result").length >= 2,
    10_000,
  );
  assert.equal(scenario.promptCalls, 1);
  assert.deepEqual(scenario.desktopSecrets, ["test-desktop-secret", "test-desktop-secret"]);
  assert.equal(scenario.frames.filter((frame) => frame.type === "started").length, 1);
  assert.ok(scenario.connectionCount >= 2);
});

test("reports a command timeout as failed and stops its heartbeat", async (t) => {
  const scenario = await startScenario(t, {
    timeoutCommand: true,
    commandTimeoutMs: 120,
  });
  await waitFor(() => scenario.frames.some((frame) => frame.type === "failed"), 10_000).catch((error) => {
    error.message += `\nstdout: ${scenario.output.join("")}\nstderr: ${scenario.errors.join("")}`;
    throw error;
  });
  const heartbeatCount = scenario.frames.filter((frame) => frame.type === "heartbeat").length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    scenario.frames.filter((frame) => frame.type === "heartbeat").length,
    heartbeatCount,
  );
});
