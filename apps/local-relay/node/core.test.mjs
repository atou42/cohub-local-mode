import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  executeRelayCommand,
  executeRelayCommandUntilAvailable,
  RelayNodeError,
} from "./core.mjs";

const command = {
  id: "relay-command-1",
  nodeId: "mac-mini",
  idempotencyKey: "3bb14c9d-7c86-47eb-88ef-e8db2acd4875",
  request: {
    method: "POST",
    path: "/api/spaces/2f4cb274-7f80-4a4b-b326-22d4af6a9873/prompt",
    body: JSON.stringify({
      sessionId: "f91aa9e1-a16c-4bbc-8154-a7ba0f30ef02",
      createSession: true,
      clientMessageId: "3bb14c9d-7c86-47eb-88ef-e8db2acd4875",
      content: [{ type: "text", text: "hello" }],
    }),
  },
};

test("resolves host auth and forwards a prompt only to the loopback API", async () => {
  const calls = [];
  const result = await executeRelayCommand(command, {
    localApiOrigin: "http://127.0.0.1:8787",
    fetcher: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/api/local-mode/auth")) {
        return Response.json({ accessToken: "host-access-token" });
      }
      return Response.json({ mode: "immediate", ok: true }, { status: 202 });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(
    calls[1].url,
    "http://127.0.0.1:8787/api/spaces/2f4cb274-7f80-4a4b-b326-22d4af6a9873/prompt",
  );
  assert.equal(calls[1].init.headers.authorization, "Bearer host-access-token");
  assert.equal(
    calls[1].init.headers["x-cohub-relay-command-id"],
    command.idempotencyKey,
  );
  assert.equal(result.status, 202);
  assert.equal(result.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(result.body), { mode: "immediate", ok: true });
});

test("rejects an arbitrary local API path before resolving credentials", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      executeRelayCommand(
        { ...command, request: { ...command.request, path: "/api/me" } },
        {
          fetcher: async () => {
            calls += 1;
            return Response.json({});
          },
        },
      ),
    (error) =>
      error instanceof RelayNodeError && error.code === "path_not_allowed",
  );
  assert.equal(calls, 0);
});

test("fails closed when host auth is unavailable", async () => {
  await assert.rejects(
    () =>
      executeRelayCommand(command, {
        fetcher: async () => new Response("offline", { status: 503 }),
      }),
    (error) =>
      error instanceof RelayNodeError && error.code === "local_auth_failed",
  );
});

test("keeps a claimed command alive while the local API starts", async () => {
  let authCalls = 0;
  const retries = [];
  const result = await executeRelayCommandUntilAvailable(command, {
    retryMinDelayMs: 1,
    retryMaxDelayMs: 2,
    onRetry: (retry) => retries.push(retry),
    fetcher: async (url) => {
      if (String(url).endsWith("/api/local-mode/auth")) {
        authCalls += 1;
        if (authCalls < 3) throw new TypeError("fetch failed");
        return Response.json({ accessToken: "host-access-token" });
      }
      return Response.json({ mode: "immediate", ok: true }, { status: 202 });
    },
  });
  assert.equal(result.status, 202);
  assert.equal(authCalls, 3);
  assert.deepEqual(
    retries.map((retry) => [retry.code, retry.retryDelayMs]),
    [
      ["local_api_unavailable", 1],
      ["local_api_unavailable", 2],
    ],
  );
});

test("stops retrying a claimed command when its lease is abandoned", async () => {
  const controller = new AbortController();
  let retries = 0;
  await assert.rejects(
    () =>
      executeRelayCommandUntilAvailable(command, {
        retryMinDelayMs: 20,
        retryMaxDelayMs: 20,
        signal: controller.signal,
        onRetry: () => {
          retries += 1;
          controller.abort(new DOMException("socket closed", "AbortError"));
        },
        fetcher: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    (error) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(retries, 1);
});

test("rejects an oversized local API response instead of truncating it", async () => {
  let call = 0;
  await assert.rejects(
    () =>
      executeRelayCommand(command, {
        maxResponseBytes: 8,
        fetcher: async () => {
          call += 1;
          return call === 1
            ? Response.json({ accessToken: "host-access-token" })
            : new Response("response-is-too-large", { status: 200 });
        },
      }),
    (error) =>
      error instanceof RelayNodeError &&
      error.code === "local_response_too_large",
  );
});

test("downloads declared relay attachments into the Space and rewrites prompt refs", async (t) => {
  const spaceStorageRoot = await mkdtemp(join(tmpdir(), "cohub-relay-node-"));
  t.after(() => rm(spaceStorageRoot, { recursive: true, force: true }));
  const attachmentId = "669526bb-bf65-4013-a825-4f61adf199f8";
  const bytes = new TextEncoder().encode("hello file");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const withAttachment = {
    ...command,
    attachments: [
      {
        id: attachmentId,
        name: "note.txt",
        size: bytes.byteLength,
        contentType: "text/plain",
        sha256,
      },
    ],
    request: {
      ...command.request,
      body: JSON.stringify({
        ...JSON.parse(command.request.body),
        content: [
          {
            type: "text",
            text: `use /relay/v1/nodes/mac-mini/attachments/${attachmentId}/content`,
          },
        ],
      }),
    },
  };
  const calls = [];
  const result = await executeRelayCommand(withAttachment, {
    relayNodeBaseUrl: "https://relay.example/v1/nodes/mac-mini",
    relayNodeToken: "node-secret",
    spaceStorageRoot,
    fetcher: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/api/local-mode/auth")) {
        return Response.json({ accessToken: "host-access-token" });
      }
      if (String(url).includes(`/attachments/${attachmentId}/content`)) {
        return new Response(bytes, {
          headers: {
            "content-type": "text/plain",
            "x-cohub-attachment-id": attachmentId,
            "x-cohub-attachment-sha256": sha256,
            "x-cohub-attachment-size": String(bytes.byteLength),
          },
        });
      }
      return Response.json({ mode: "immediate", ok: true }, { status: 202 });
    },
  });
  assert.equal(result.status, 202);
  const downloadCall = calls.find((item) => item.url.includes("/attachments/"));
  assert.equal(downloadCall.init.headers.authorization, "Bearer node-secret");
  assert.equal(downloadCall.init.headers["x-cohub-relay-node"], "1");
  const promptCall = calls.at(-1);
  const localPath = join(
    spaceStorageRoot,
    "2f4cb274-7f80-4a4b-b326-22d4af6a9873",
    "workspace",
    ".cohub",
    "relay-attachments",
    attachmentId,
    "note.txt",
  );
  assert.match(promptCall.init.body, new RegExp(localPath.replaceAll("/", "\\/")));
  assert.doesNotMatch(promptCall.init.body, /relay-attachment:/);
  assert.equal(await readFile(localPath, "utf8"), "hello file");
});

test("restores relay attachment references in the terminal result", async (t) => {
  const spaceStorageRoot = await mkdtemp(join(tmpdir(), "cohub-relay-node-"));
  t.after(() => rm(spaceStorageRoot, { recursive: true, force: true }));
  const attachmentId = "669526bb-bf65-4013-a825-4f61adf199f8";
  const bytes = new TextEncoder().encode("hello file");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const withAttachment = {
    ...command,
    attachments: [
      {
        id: attachmentId,
        name: "note.txt",
        size: bytes.byteLength,
        contentType: "text/plain",
        sha256,
      },
    ],
    request: {
      ...command.request,
      body: JSON.stringify({
        ...JSON.parse(command.request.body),
        content: [{ type: "text", text: `use relay-attachment://${attachmentId}` }],
      }),
    },
  };
  const result = await executeRelayCommand(withAttachment, {
    relayNodeBaseUrl: "https://relay.example/v1/nodes/mac-mini",
    relayNodeToken: "node-secret",
    spaceStorageRoot,
    fetcher: async (url, init = {}) => {
      const target = String(url);
      if (target.endsWith("/api/local-mode/auth")) {
        return Response.json({ accessToken: "host-access-token" });
      }
      if (target.includes(`/attachments/${attachmentId}/content`)) {
        return new Response(bytes, {
          headers: {
            "content-type": "text/plain",
            "x-cohub-attachment-id": attachmentId,
            "x-cohub-attachment-sha256": sha256,
            "x-cohub-attachment-size": String(bytes.byteLength),
          },
        });
      }
      const sent = JSON.parse(init.body);
      return Response.json({
        mode: "immediate",
        session: { id: "f91aa9e1-a16c-4bbc-8154-a7ba0f30ef02" },
        turn: {
          id: "bd5bc93a-c1a4-45f8-8ba2-bc45fb87ce01",
          status: "completed",
          userContent: sent.content,
        },
      });
    },
  });

  assert.match(
    result.body,
    new RegExp(`/relay/v1/nodes/[^/]+/attachments/${attachmentId}/content`),
  );
  assert.doesNotMatch(result.body, /cohub-relay-node-/);
});

test("relays files explicitly linked by the assistant without exposing local paths", async (t) => {
  const spaceStorageRoot = await mkdtemp(join(tmpdir(), "cohub-relay-node-"));
  t.after(() => rm(spaceStorageRoot, { recursive: true, force: true }));
  const workspaceRoot = join(
    spaceStorageRoot,
    "2f4cb274-7f80-4a4b-b326-22d4af6a9873",
    "workspace",
  );
  const artifactPath = join(workspaceRoot, "output", "report.txt");
  await mkdir(join(workspaceRoot, "output"), { recursive: true });
  await writeFile(artifactPath, "returned artifact bytes", "utf8");
  const attachmentId = "a6d6ae8f-205b-4e91-bdc4-e46f818ad505";
  let uploaded = Buffer.alloc(0);
  let persistedProjection = null;
  const calls = [];
  const result = await executeRelayCommand(command, {
    relayNodeBaseUrl: "https://relay.example/v1/nodes/mac-mini",
    relayNodeToken: "node-secret",
    spaceStorageRoot,
    fetcher: async (url, init = {}) => {
      const target = String(url);
      calls.push({ target, init });
      if (target.endsWith("/api/local-mode/auth")) {
        return Response.json({ accessToken: "host-access-token" });
      }
      if (target.endsWith(command.request.path)) {
        return Response.json({
          mode: "immediate",
          session: { id: "f91aa9e1-a16c-4bbc-8154-a7ba0f30ef02" },
          turn: {
            id: "bd5bc93a-c1a4-45f8-8ba2-bc45fb87ce01",
            status: "completed",
            assistantText: "Download [report](output/report.txt)",
            assistantContent: [
              { type: "text", text: "Download [report](output/report.txt)" },
            ],
            summary: { text: "Download [report](output/report.txt)" },
          },
        });
      }
      if (target.endsWith("/attachments")) {
        const planned = JSON.parse(init.body);
        assert.equal(planned.name, "report.txt");
        assert.equal(planned.size, 23);
        assert.equal(planned.contentType, "text/plain");
        assert.match(planned.sha256, /^[0-9a-f]{64}$/);
        assert.equal(init.headers.authorization, "Bearer node-secret");
        assert.equal(init.headers["x-cohub-relay-node"], "1");
        return Response.json({
          attachment: { id: attachmentId, nodeId: "mac-mini" },
          upload: {
            url: `https://relay.example/v1/nodes/mac-mini/attachments/${attachmentId}/content?uploadToken=one-use`,
          },
        });
      }
      if (target.includes(`/attachments/${attachmentId}/content`)) {
        const chunks = [];
        for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
        uploaded = Buffer.concat(chunks);
        assert.equal(init.headers.authorization, "Bearer node-secret");
        assert.equal(init.headers["x-cohub-relay-node"], "1");
        return Response.json({ ok: true });
      }
      if (target.endsWith("/api/local-mode/relay-artifacts")) {
        persistedProjection = JSON.parse(init.body);
        assert.equal(init.headers.authorization, "Bearer host-access-token");
        return Response.json({ ok: true });
      }
      throw new Error(`Unexpected fetch ${target}`);
    },
  });
  assert.equal(uploaded.toString("utf8"), "returned artifact bytes");
  const payload = JSON.parse(result.body);
  const relayPath = `/relay/v1/nodes/mac-mini/attachments/${attachmentId}/content`;
  assert.equal(payload.turn.assistantText, `Download [report](${relayPath})`);
  assert.equal(payload.turn.assistantContent[0].text, `Download [report](${relayPath})`);
  assert.equal(payload.turn.summary.text, `Download [report](${relayPath})`);
  assert.deepEqual(persistedProjection, {
    sessionId: "f91aa9e1-a16c-4bbc-8154-a7ba0f30ef02",
    turnId: "bd5bc93a-c1a4-45f8-8ba2-bc45fb87ce01",
    replacements: [{ from: "output/report.txt", to: relayPath }],
  });
  assert.doesNotMatch(result.body, new RegExp(workspaceRoot));
  assert.equal(calls.length, 5);
});

test("does not relay assistant links outside the Space workspace", async (t) => {
  const spaceStorageRoot = await mkdtemp(join(tmpdir(), "cohub-relay-node-"));
  t.after(() => rm(spaceStorageRoot, { recursive: true, force: true }));
  await mkdir(
    join(
      spaceStorageRoot,
      "2f4cb274-7f80-4a4b-b326-22d4af6a9873",
      "workspace",
    ),
    { recursive: true },
  );
  let calls = 0;
  const result = await executeRelayCommand(command, {
    relayNodeBaseUrl: "https://relay.example/v1/nodes/mac-mini",
    relayNodeToken: "node-secret",
    spaceStorageRoot,
    fetcher: async (url) => {
      calls += 1;
      if (String(url).endsWith("/api/local-mode/auth")) {
        return Response.json({ accessToken: "host-access-token" });
      }
      return Response.json({
        mode: "immediate",
        session: { id: "f91aa9e1-a16c-4bbc-8154-a7ba0f30ef02" },
        turn: {
          id: "bd5bc93a-c1a4-45f8-8ba2-bc45fb87ce01",
          status: "completed",
          assistantText: "Do not export [secret](/etc/passwd)",
        },
      });
    },
  });
  assert.equal(calls, 2);
  assert.match(result.body, /\[secret\]\(\/etc\/passwd\)/);
});

test("rejects an undeclared relay attachment before downloading it", async () => {
  const undeclared = {
    ...command,
    request: {
      ...command.request,
      body: command.request.body.replace("hello", "relay-attachment://669526bb-bf65-4013-a825-4f61adf199f8"),
    },
  };
  let calls = 0;
  await assert.rejects(
    () =>
      executeRelayCommand(undeclared, {
        fetcher: async () => {
          calls += 1;
          return Response.json({ accessToken: "host-access-token" });
        },
      }),
    (error) =>
      error instanceof RelayNodeError && error.code === "attachment_ref_not_declared",
  );
  assert.equal(calls, 1);
});

test("keeps the relay command running until the local turn is terminal", async () => {
  let promptCalls = 0;
  let pollCalls = 0;
  const result = await executeRelayCommand(command, {
    fetcher: async (url) => {
      const path = String(url);
      if (path.endsWith("/api/local-mode/auth")) {
        return Response.json({ accessToken: "host-access-token" });
      }
      if (path.includes("/api/sessions/") && path.includes("/turns/")) {
        pollCalls += 1;
        return Response.json({
          session: { id: "f91aa9e1-a16c-4bbc-8154-a7ba0f30ef02" },
          turn: {
            id: "bd5bc93a-c1a4-45f8-8ba2-bc45fb87ce01",
            status: "completed",
            assistantText: "done",
          },
        });
      }
      promptCalls += 1;
      return Response.json(
        {
          mode: "immediate",
          session: { id: "f91aa9e1-a16c-4bbc-8154-a7ba0f30ef02" },
          turn: {
            id: "bd5bc93a-c1a4-45f8-8ba2-bc45fb87ce01",
            status: "running",
          },
        },
        { status: 202 },
      );
    },
  });
  assert.equal(promptCalls, 1);
  assert.equal(pollCalls, 1);
  const payload = JSON.parse(result.body);
  assert.equal(payload.mode, "immediate");
  assert.equal(payload.turn.status, "completed");
  assert.equal(payload.turn.assistantText, "done");
});
