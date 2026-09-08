import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import type { AgentHarness } from "@cohub/protocol";
import { resolveLocalCliProxyOverrides } from "@cohub/infra/local-cli-proxy";

type ExternalHarness = Exclude<AgentHarness, "pi">;
type StatusResult = { code: number | null; stdout: string; stderr: string };
type StatusRunner = (command: string, args: string[]) => Promise<StatusResult>;

const PROBE_TIMEOUT_MS = 30_000;

export function isExplicitSignOut(message: string) {
  return /not (?:logged|signed) in|not authenticated|authentication required|please (?:log|sign) in|no cached (?:token|credentials)|cached (?:token|credentials) (?:not found|missing)/i.test(message);
}

export function parseCliAuthenticationStatus(harness: "codex" | "cursor", result: StatusResult) {
  const output = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`);
  if (isExplicitSignOut(output)) return false;
  if (result.code === 0 && /\b(?:logged in|authenticated)\b/i.test(output)) return true;
  // Status output can contain an account address or part of a key. Never expose it.
  throw new Error(`${harness} CLI status could not be confirmed (exit ${result.code ?? "unknown"}).`);
}

const runStatus: StatusRunner = async (command, args) => {
  const env = { ...process.env, ...await resolveLocalCliProxyOverrides(), NO_COLOR: "1" };
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: homedir(),
      env,
      timeout: PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== "number")) {
        reject(new Error(error.killed ? "CLI authentication status timed out." : "CLI authentication status could not be started."));
        return;
      }
      resolve({ code: (error?.code as number | undefined) ?? 0, stdout, stderr });
    });
  });
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function grokAuthenticationMethod(result: unknown, hasApiKey: boolean) {
  const methods = record(result)?.authMethods;
  if (!Array.isArray(methods) || methods.some((method) => typeof record(method)?.id !== "string")) {
    throw new Error("Grok CLI returned invalid authentication methods.");
  }
  const ids = methods.map((method) => record(method)?.id);
  if (hasApiKey && ids.includes("xai.api_key")) return "xai.api_key";
  return ids.includes("cached_token") ? "cached_token" : null;
}

export async function probeGrokAuthentication(command = "grok"): Promise<boolean> {
  const env = { ...process.env, ...await resolveLocalCliProxyOverrides() };
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["--no-auto-update", "agent", "stdio"], {
      cwd: homedir(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    let outputBytes = 0;
    const finish = (error: Error | null, authenticated = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      error ? reject(error) : resolve(authenticated);
    };
    const timer = setTimeout(() => finish(new Error("Grok CLI authentication status timed out.")), PROBE_TIMEOUT_MS);
    const send = (id: number, method: string, params: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    };
    child.stdin.on("error", () => finish(new Error("Grok CLI authentication channel closed.")));
    child.stderr.on("data", () => {});
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024) finish(new Error("Grok CLI authentication response was too large."));
    });
    child.once("error", () => finish(new Error("Grok CLI authentication status could not be started.")));
    child.once("exit", (code) => finish(new Error(`Grok CLI authentication status exited before confirmation (exit ${code ?? "unknown"}).`)));
    lines.on("line", (line) => {
      if (settled || !line.trim()) return;
      let response: Record<string, unknown> | null;
      try {
        response = record(JSON.parse(line));
      } catch {
        finish(new Error("Grok CLI authentication response was invalid JSON."));
        return;
      }
      if (!response || (response.id !== 1 && response.id !== 2)) return;
      const error = record(response.error);
      if (error) {
        const message = typeof error.message === "string" ? error.message : "";
        if (isExplicitSignOut(message)) finish(null, false);
        else finish(new Error(`Grok CLI authentication failed (code ${typeof error.code === "number" ? error.code : "unknown"}).`));
        return;
      }
      if (!record(response.result)) {
        finish(new Error("Grok CLI authentication returned an invalid result."));
        return;
      }
      if (response.id === 1) {
        let methodId: string | null;
        try {
          methodId = grokAuthenticationMethod(response.result, Boolean(process.env.XAI_API_KEY?.trim()));
        } catch (error) {
          finish(error as Error);
          return;
        }
        if (!methodId) {
          finish(null, false);
          return;
        }
        send(2, "authenticate", { methodId, _meta: { headless: true } });
      } else finish(null, true);
    });
    send(1, "initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "cohub-local-readiness", version: "1" },
    });
  });
}

export async function probeCliAuthentication(
  harness: ExternalHarness,
  dependencies: { runStatus?: StatusRunner; grok?: () => Promise<boolean> } = {},
) {
  if (harness === "grok_build") return (dependencies.grok ?? probeGrokAuthentication)();
  const command = harness === "cursor" ? process.env.CURSOR_AGENT_COMMAND?.trim() || "agent" : "codex";
  const args = harness === "cursor" ? ["--disable-auto-update", "status"] : ["login", "status"];
  return parseCliAuthenticationStatus(harness, await (dependencies.runStatus ?? runStatus)(command, args));
}
