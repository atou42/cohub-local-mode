import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { isLocalHarness, resolveCohubEnvironment, resolveWebsocketUrl } from "@neta-art/cohub";
import type { Command } from "commander";
import { requireAccessToken } from "../auth.js";
import { createClient } from "../client.js";
import { error, json as outJson, jsonRequested } from "../output.js";
import { currentIdentityKey, explicitSpace, resolveSpace } from "../space.js";
import { canonicalRuntimeRoot, resolveRuntimeSpace } from "../runtime/space-binding.js";
import { discoverHarnesses } from "../runtime/harness.js";
import { serveRuntime } from "../runtime/connection.js";
import { RuntimeSessionStore } from "../runtime/session-store.js";
import { ensureSandboxdBinary } from "./sandboxd-binary.js";
import {
  readRuntimeDiagnosticEvents,
  RuntimeDiagnosticReader,
  RuntimeDiagnostics,
  runtimeDiagnosticsDirectory,
  serializeDiagnosticError,
} from "../runtime/diagnostics.js";

export const resolveLocalSpaceName = (root: string, name?: string) => name?.trim() || basename(root) || "local-space";

type Options = { space?: string; name?: string; harness: string[]; pi?: string; codex?: string; yes?: boolean; json?: boolean };

type DiagnosticLevel = "debug" | "info" | "warn" | "error";

function sandboxOutputLevel(value: unknown, stream: "stdout" | "stderr"): DiagnosticLevel {
  const level = typeof value === "string" ? value.toLowerCase() : "";
  if (level.includes("error")) return "error";
  if (level.includes("warn")) return "warn";
  return stream === "stderr" ? "error" : "debug";
}

function captureSandboxOutput(
  stream: NodeJS.ReadableStream | null,
  streamName: "stdout" | "stderr",
  diagnostics: RuntimeDiagnostics,
): void {
  if (!stream) return;
  let pending = "";
  const consume = (chunk: unknown) => {
    pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) recordSandboxOutput(line, streamName, diagnostics);
      newline = pending.indexOf("\n");
    }
  };
  stream.on("data", consume);
  stream.on("end", () => {
    if (pending.trim()) recordSandboxOutput(pending.trim(), streamName, diagnostics);
  });
}

function recordSandboxOutput(
  line: string,
  streamName: "stdout" | "stderr",
  diagnostics: RuntimeDiagnostics,
): void {
  let parsed: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(line);
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    // Older or third-party binaries may still emit text logs.
  }
  const level = sandboxOutputLevel(parsed?.level, streamName);
  const message = typeof parsed?.msg === "string" ? parsed.msg : line;
  const data = parsed
    ? Object.fromEntries(Object.entries(parsed).filter(([key]) => !["msg", "level", "time"].includes(key)))
    : { message: line };
  diagnostics.log(level, "sandboxd.log", {
    stream: streamName,
    message,
    ...(level === "error" ? { error: { message } } : {}),
    ...data,
  }, { component: "sandboxd" });
}

function printDiagnostic(event: Awaited<ReturnType<typeof readRuntimeDiagnosticEvents>>[number]): void {
  const scope = [event.component, event.event].filter(Boolean).join(".");
  const context = [
    event.connectionId && `connection=${event.connectionId}`,
    event.sessionId && `session=${event.sessionId}`,
    event.turnId && `turn=${event.turnId}`,
    event.traceContext?.requestId && `request=${event.traceContext.requestId}`,
    event.traceContext?.traceId && `trace=${event.traceContext.traceId}`,
  ].filter(Boolean).join(" ");
  const data = event.data && Object.keys(event.data).length > 0 ? ` ${JSON.stringify(event.data)}` : "";
  process.stdout.write(`${event.timestamp} ${event.level.toUpperCase().padEnd(5)} ${scope}${context ? ` ${context}` : ""}${data}${event.error ? ` ${JSON.stringify(event.error)}` : ""}\n`);
}
export function parseRuntimeHarnesses(values: string[]): ("pi" | "codex")[] {
  const names = values.flatMap((value) => value.split(",")).map((name) => name.trim()).filter(Boolean);
  if (names.some((name) => !isLocalHarness(name))) throw new Error("Harness must be pi or codex");
  return [...new Set(names.length ? names : ["pi"])] as ("pi" | "codex")[];
}

export function registerRuntime(program: Command) {
  const runtime = program.command("runtime").description("Connect a local workspace");
  runtime.command("up [dir]")
    .description("Connect local Harnesses and files")
    .option("-s, --space <id>", "Target Space")
    .option("-n, --name <name>", "New Space name")
    .option("--harness <name>", "Pi or Codex; repeatable", (value: string, previous: string[]) => [...previous, value], [])
    .option("--pi <path>", "Pi executable")
    .option("--codex <path>", "Codex executable")
    .option("-y, --yes", "Accept local execution access")
    .option("--json", "JSON output")
    .action(async (dir: string | undefined, options: Options) => {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      try {
        const requestedRoot = resolve(dir ?? process.cwd());
        if (!(await stat(requestedRoot)).isDirectory()) throw new Error("Workspace is not a directory");
        const root = await canonicalRuntimeRoot(requestedRoot);
        const harnesses = parseRuntimeHarnesses(options.harness);
        if (!options.yes) {
          if (!process.stdin.isTTY) throw new Error("Use --yes to authorize local execution");
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          try {
            const answer = await rl.question(`Connect ${root}? Space collaborators can run commands as your OS user, beyond this folder. [y/N] `);
            if (!/^y(es)?$/i.test(answer.trim())) return;
          } finally { rl.close(); }
        }
        const capabilities = await discoverHarnesses(harnesses, options, root);
        const client = createClient();
        const requested = options.space?.trim() || explicitSpace(program);
        const validateLocalRuntime = async (spaceId: string) => {
          const sandbox = (await client.space(spaceId).sandbox.get()).sandbox;
          if (sandbox?.provider !== "local") throw new Error("Space does not have a local Runtime");
        };
        const { spaceId } = await resolveRuntimeSpace({
          root,
          identityKey: currentIdentityKey(),
          explicitSpaceId: requested,
          createSpace: async () => (await client.spaces.create({
            name: resolveLocalSpaceName(root, options.name),
            config: { sandbox: { provider: "local" } },
          })).space.id,
          validateSpace: validateLocalRuntime,
        });
        const store = new RuntimeSessionStore(spaceId, undefined, client.space(spaceId));
        const runtimeId = randomUUID();
        const diagnostics = new RuntimeDiagnostics({ root: store.root, spaceId, runtimeId });
        store.setDiagnostics(diagnostics);
        diagnostics.log("info", "runtime.cli_started", {
          platform: process.platform,
          arch: process.arch,
          node: process.versions.node,
          harnesses,
          proxyConfigured: ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"].some((key) => Boolean(process.env[key]?.trim())),
        });
        try {
          const binary = await ensureSandboxdBinary({
            onStatus: (message) => diagnostics.log("info", "sandboxd.download", { message }, { component: "sandboxd" }),
          });
          const wsBase = resolveWebsocketUrl({ url: process.env.COHUB_WS_URL });
          const url = new URL(wsBase); url.pathname = "/runtime/relay";
          const relay = new URL(wsBase); relay.pathname = "/sandbox/relay";
          let bridge: ReturnType<typeof spawn> | null = null;
          let bridgeClosed: Promise<void> = Promise.resolve();
          let announced = false;
          const token = await requireAccessToken();
          try {
            await serveRuntime({
              spaceId,
              cwd: root,
              url: url.toString(),
              capabilities,
              harnesses: options,
              runtimeId,
              diagnostics,
              token: requireAccessToken,
              signal: controller.signal,
              store,
              onReady: () => {
                if (!bridge) {
                  bridge = spawn(binary, ["--local", "--space", spaceId, "--root", root, "--relay", process.env.COHUB_RELAY_URL?.trim() || relay.toString()], {
                    stdio: ["ignore", "pipe", "pipe"],
                    env: {
                      ...process.env,
                      COHUB_RELAY_TOKEN: token,
                      COHUB_RUNTIME_ID: runtimeId,
                      COHUB_LOG_FORMAT: "json",
                    },
                  });
                  captureSandboxOutput(bridge.stdout, "stdout", diagnostics);
                  captureSandboxOutput(bridge.stderr, "stderr", diagnostics);
                  bridgeClosed = new Promise((resolveClosed) => bridge?.once("close", () => resolveClosed()));
                  bridge.on("error", (cause) => {
                    diagnostics.log("error", "sandboxd.process_error", { error: serializeDiagnosticError(cause) }, { component: "sandboxd" });
                    console.error(cause);
                    controller.abort();
                  });
                  bridge.once("exit", (code, signal) => {
                    diagnostics.log(code === 0 ? "info" : "error", "sandboxd.process_exit", { code, signal }, { component: "sandboxd" });
                    controller.abort();
                  });
                }
                if (announced) return;
                announced = true;
                const webUrl = `${resolveCohubEnvironment() === "prod" ? "https://cohub.live" : "https://dev.cohub.live"}/spaces/${spaceId}`;
                if (jsonRequested(options)) outJson({ spaceId, root, harnesses, runtimeId, diagnosticsPath: diagnostics.logPath, url: webUrl });
                else console.error(`Runtime connected: ${webUrl} (runtimeId=${runtimeId}, logs=${diagnostics.logPath})`);
              },
            });
          } finally {
            if (bridge) {
              const child = bridge as ReturnType<typeof spawn>;
              child.kill("SIGTERM");
              const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
              await bridgeClosed;
              clearTimeout(timeout);
            }
          }
        } catch (cause) {
          diagnostics.log("error", "runtime.start_failed", { error: serializeDiagnosticError(cause) });
          throw cause;
        } finally {
          await diagnostics.close().catch((error) => console.error("Runtime diagnostics close failed:", error));
        }
      } catch (cause) { if (!controller.signal.aborted) error("Runtime failed", cause instanceof Error ? cause.message : String(cause)); }
      finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
    });
  runtime.command("status").description("Runtime status").option("-s, --space <id>", "Target Space").action(async (options: { space?: string }) => {
    const spaceId = options.space?.trim() || await resolveSpace(program);
    const store = new RuntimeSessionStore(spaceId);
    const [status, pendingLocalArchives, failedLocalArchives] = await Promise.all([
      createClient().space(spaceId).getRuntime(),
      store.archives.pendingCount(),
      store.archives.failedCaptureCount(),
    ]);
    outJson({
      ...status,
      diagnosticsPath: runtimeDiagnosticsDirectory(store.root),
      pendingLocalArchives,
      failedLocalArchives,
    });
  });

  runtime.command("logs")
    .description("Read local Runtime diagnostics")
    .option("-s, --space <id>", "Target Space")
    .option("-l, --limit <count>", "Number of events", "100")
    .option("--follow", "Keep watching for new events")
    .option("--json", "Print raw diagnostic events")
    .action(async (options: { space?: string; limit?: string; follow?: boolean; json?: boolean }) => {
      const spaceId = options.space?.trim() || await resolveSpace(program);
      const store = new RuntimeSessionStore(spaceId);
      const limit = Number(options.limit ?? "100");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) return error("Invalid diagnostic limit", "Use an integer between 1 and 10000 / 使用 1 到 10000 之间的整数");
      const asJson = jsonRequested(options);
      const reader = options.follow ? new RuntimeDiagnosticReader(store.root) : null;
      const render = async () => {
        const fresh = options.follow
          ? await reader?.read({ limit }) ?? []
          : await readRuntimeDiagnosticEvents(store.root, { limit });
        if (options.follow && fresh.length === 0) return;
        if (asJson && options.follow) {
          for (const event of fresh) process.stdout.write(`${JSON.stringify(event)}\n`);
        } else if (asJson) {
          outJson(fresh);
        } else if (fresh.length === 0) {
          process.stdout.write("No Runtime diagnostics / 未找到 Runtime 诊断记录\n");
        } else {
          for (const event of fresh) printDiagnostic(event);
        }
      };

      try {
        await render();
        if (!options.follow) return;
        await new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout> | null = null;
          let stopped = false;
          const stop = () => {
            stopped = true;
            if (timer) clearTimeout(timer);
            process.removeListener("SIGINT", stop);
            process.removeListener("SIGTERM", stop);
            resolve();
          };
          const poll = async () => {
            if (stopped) return;
            try {
              await render();
            } catch {
              stop();
              return;
            }
            if (!stopped) timer = setTimeout(() => void poll(), 2_000);
          };
          timer = setTimeout(() => void poll(), 2_000);
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
      } catch (cause) {
        error("Runtime logs failed", cause instanceof Error ? cause.message : String(cause));
      }
    });
}
