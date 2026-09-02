import type {
  AgentHarness,
  HarnessCapabilityCatalog,
  HarnessCapabilityCommand,
  HarnessCapabilitySkill,
} from "@cohub/protocol";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { config } from "../config.js";

const PROBE_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60_000;
const MAX_STDERR_CHARS = 8_000;
const GROK_ACP_EXECUTABLE_COMMANDS = new Set([
  "context",
  "session-info",
  "deep-research",
  "workflow",
  "goal",
]);
const CURSOR_BUILTIN_COMMANDS: HarnessCapabilityCommand[] = ([
  ["goal", "Set a goal that Cursor will pursue to completion", "<objective>"],
  ["loop", "Run a prompt or skill repeatedly", "<interval> <prompt>"],
  ["create-plan", "Create an implementation plan before editing", ""],
  ["create-rule", "Create persistent Cursor rules", ""],
	["create-skill", "Create a Cursor Agent Skill", ""],
] satisfies Array<[string, string, string]>).map(
	([name, description, argumentHint]): HarnessCapabilityCommand => ({
	name,
	description,
	...(argumentHint ? { argumentHint } : {}),
	category: "Cursor",
	insertionText: `/${name}${argumentHint ? " " : ""}`,
	}),
);
const cache = new Map<string, { expiresAt: number; value: HarnessCapabilityCatalog }>();
const inFlight = new Map<string, Promise<HarnessCapabilityCatalog>>();

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function workspacePath(spaceId: string) {
  return join(config.spaceStorageRoot, spaceId, "workspace");
}

function runJsonRpcProbe(input: {
  command: string;
  args: string[];
  cwd: string;
  initializeParams: JsonObject;
  afterInitialize?: (send: (payload: JsonObject) => void) => void;
  afterResponse?: (payload: JsonObject, send: (payload: JsonObject) => void) => void;
  acceptDelayMs?: number;
  accept: (payload: JsonObject) => JsonObject | null;
}): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const stdout = createInterface({ input: child.stdout });
    let stderr = "";
    let settled = false;
    let initialized = false;

    const finish = (error: Error | null, value?: JsonObject) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout.close();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value ?? {});
    };
    const send = (payload: JsonObject) => {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    };
    const timer = setTimeout(() => {
      finish(new Error(`${input.command} capability discovery timed out`));
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();

    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-MAX_STDERR_CHARS);
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (settled) return;
      const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
      finish(
        new Error(
          `${input.command} capability discovery exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}${detail}`,
        ),
      );
    });
    stdout.on("line", (line) => {
      if (settled || !line.trim()) return;
      let payload: JsonObject;
      try {
        const parsed = record(JSON.parse(line));
        if (!parsed) throw new Error("response is not an object");
        payload = parsed;
      } catch (error) {
        finish(
          new Error(
            `${input.command} capability discovery returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      const rpcError = record(payload.error);
      if (rpcError && payload.id !== undefined) {
        finish(
          new Error(
            `${input.command} capability discovery failed: ${text(rpcError.message) || JSON.stringify(rpcError)}`,
          ),
        );
        return;
      }
      if (!initialized && payload.id === 1 && record(payload.result)) {
        initialized = true;
        input.afterInitialize?.(send);
      }
      input.afterResponse?.(payload, send);
      const accepted = input.accept(payload);
      if (accepted) {
        const delay = input.acceptDelayMs ?? 0;
        if (delay > 0) setTimeout(() => finish(null, accepted), delay).unref?.();
        else finish(null, accepted);
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: input.initializeParams,
    });
  });
}

export function parseCodexSkills(result: JsonObject): HarnessCapabilitySkill[] {
  const scopes = new Set(["user", "repo", "system", "admin"] as const);
  const byName = new Map<string, HarnessCapabilitySkill>();
  for (const entryValue of Array.isArray(result.data) ? result.data : []) {
    const entry = record(entryValue);
    for (const skillValue of Array.isArray(entry?.skills) ? entry.skills : []) {
      const skill = record(skillValue);
      const name = text(skill?.name);
      const description = text(skill?.description);
      const scope = text(skill?.scope);
      if (
        !name ||
        !description ||
        skill?.enabled !== true ||
        !scopes.has(scope as "user" | "repo" | "system" | "admin")
      ) continue;
      byName.set(name, {
        name,
        description,
        scope: scope as HarnessCapabilitySkill["scope"],
        insertionText: `$${name} `,
      });
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function discoverCodex(spaceId: string, forceReload: boolean): Promise<HarnessCapabilityCatalog> {
  const result = await runJsonRpcProbe({
    command: "codex",
    args: ["app-server", "--listen", "stdio://"],
    cwd: workspacePath(spaceId),
    initializeParams: {
      clientInfo: { name: "cohub-local-capabilities", version: "1" },
      capabilities: { experimentalApi: true },
    },
    afterInitialize(send) {
      send({ jsonrpc: "2.0", method: "initialized", params: {} });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "skills/list",
        params: { cwds: [workspacePath(spaceId)], forceReload },
      });
    },
    accept(payload) {
      return payload.id === 2 ? record(payload.result) : null;
    },
  });
  return {
    version: 1,
    harness: "codex",
    fetchedAt: new Date().toISOString(),
    commands: [{
      name: "goal",
      description: "Set, inspect, continue, or clear the persistent Codex goal",
      argumentHint: "<objective> | status | clear",
      category: "Codex",
      insertionText: "/goal ",
    }],
    skills: parseCodexSkills(result),
  };
}

export function parseGrokCommands(result: JsonObject): HarnessCapabilityCommand[] {
  const meta = record(result._meta);
  const commands = Array.isArray(meta?.availableCommands)
    ? meta.availableCommands
    : [];
  return commands.flatMap((value) => {
    const command = record(value);
    const name = text(command?.name);
    const description = text(command?.description);
    if (!name || !description || !GROK_ACP_EXECUTABLE_COMMANDS.has(name)) return [];
    const input = record(command?.input);
    const argumentHint = text(input?.hint);
    return [{
      name,
      description,
      ...(argumentHint ? { argumentHint } : {}),
      category: "Grok Build",
      insertionText: `/${name}${argumentHint ? " " : ""}`,
    } satisfies HarnessCapabilityCommand];
  }).sort((left, right) => left.name.localeCompare(right.name));
}

export function parseCursorCommands(result: JsonObject): HarnessCapabilityCommand[] {
  const updates = Array.isArray(result.availableCommands) ? result.availableCommands : [];
  return updates.flatMap((value) => {
    const command = record(value);
    const name = text(command?.name);
    const description = text(command?.description);
    if (!name || !description) return [];
    const input = record(command?.input);
    const argumentHint = text(input?.hint);
    return [{
      name,
      description,
      ...(argumentHint ? { argumentHint } : {}),
      category: "Cursor",
      insertionText: `/${name}${argumentHint ? " " : ""}`,
    } satisfies HarnessCapabilityCommand];
  }).sort((left, right) => left.name.localeCompare(right.name));
}

async function discoverGrok(spaceId: string): Promise<HarnessCapabilityCatalog> {
  const result = await runJsonRpcProbe({
    command: "grok",
    args: ["agent", "stdio"],
    cwd: workspacePath(spaceId),
    initializeParams: {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "cohub-local-capabilities", version: "1" },
    },
    accept(payload) {
      return payload.id === 1 ? record(payload.result) : null;
    },
  });
  return {
    version: 1,
    harness: "grok_build",
    fetchedAt: new Date().toISOString(),
    commands: parseGrokCommands(result),
    skills: [],
  };
}

async function discoverCursor(_spaceId: string): Promise<HarnessCapabilityCatalog> {
  // Cursor advertises its builtin slash commands asynchronously, after the
  // session/new response. Returning the stable builtin subset here keeps the
  // composer instant; the runtime still forwards any newly advertised commands
  // as visible session events.
  const commands: HarnessCapabilityCommand[] = [...CURSOR_BUILTIN_COMMANDS];
  return {
    version: 1,
    harness: "cursor",
    fetchedAt: new Date().toISOString(),
    commands,
    skills: [],
  };
}

async function discover(spaceId: string, harness: AgentHarness, forceReload: boolean) {
  if (harness === "pi") {
    return {
      version: 1,
      harness,
      fetchedAt: new Date().toISOString(),
      commands: [],
      skills: [],
    } satisfies HarnessCapabilityCatalog;
  }
  if (harness === "codex") return discoverCodex(spaceId, forceReload);
  if (harness === "grok_build") return discoverGrok(spaceId);
  return discoverCursor(spaceId);
}

export async function loadHarnessCapabilities(input: {
  spaceId: string;
  harness: AgentHarness;
  forceReload?: boolean;
}): Promise<HarnessCapabilityCatalog> {
  const key = `${input.spaceId}:${input.harness}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (!input.forceReload && cached && cached.expiresAt > now) return cached.value;
  const active = inFlight.get(key);
  if (active) return active;

  const operation = discover(input.spaceId, input.harness, Boolean(input.forceReload))
    .then((value) => {
      cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
      return value;
    })
    .finally(() => {
      if (inFlight.get(key) === operation) inFlight.delete(key);
    });
  inFlight.set(key, operation);
  return operation;
}

export function clearHarnessCapabilityCacheForTests() {
  cache.clear();
  inFlight.clear();
}
