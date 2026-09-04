import {
  AGENT_HARNESSES,
  type AgentHarness,
  type HarnessReadinessAction,
  type HarnessReadinessEntry,
  type HarnessReadinessResponse,
} from "@cohub/protocol";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { loadExternalHarnessCatalog } from "./harness-catalog.js";

type ExternalHarness = Exclude<AgentHarness, "pi">;

type ExecutableProbe = {
  installed: boolean;
  version?: string;
};

export type HarnessReadinessDependencies = {
  probeExecutable: (harness: ExternalHarness) => Promise<ExecutableProbe>;
  hasAuthentication: (harness: ExternalHarness) => Promise<boolean>;
  loadCatalog: (harness: ExternalHarness) => Promise<unknown>;
  now?: () => number;
  ttlMs?: number;
};

const LABELS: Record<AgentHarness, string> = {
  pi: "Pi",
  codex: "Codex",
  grok_build: "Grok Build",
  cursor: "Cursor",
};

const INSTALL_ACTIONS: Record<ExternalHarness, HarnessReadinessAction> = {
  codex: {
    kind: "install",
    label: "Install Codex CLI",
    command: "npm install -g @openai/codex",
    href: "https://developers.openai.com/codex/cli",
  },
  grok_build: {
    kind: "install",
    label: "Install Grok Build",
    command: "curl -fsSL https://x.ai/cli/install.sh | bash",
    href: "https://docs.x.ai/build/overview",
  },
  cursor: {
    kind: "install",
    label: "Install Cursor Agent",
    command: "curl https://cursor.com/install -fsS | bash",
    href: "https://cursor.com/cli",
  },
};

const SIGN_IN_ACTIONS: Record<ExternalHarness, HarnessReadinessAction> = {
  codex: { kind: "sign_in", label: "Sign in to Codex", command: "codex login" },
  grok_build: { kind: "sign_in", label: "Sign in to Grok Build", command: "grok login" },
  cursor: { kind: "sign_in", label: "Sign in to Cursor", command: "agent login" },
};

function unavailableEntry(
  harness: ExternalHarness,
  state: Exclude<HarnessReadinessEntry["state"], "ready">,
  detail: string,
  action: HarnessReadinessAction,
  version?: string,
): HarnessReadinessEntry {
  return {
    harness,
    label: LABELS[harness],
    state,
    bundled: false,
    ...(version ? { version } : {}),
    detail,
    action,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function looksLikeAuthenticationFailure(message: string) {
  return /auth|login|log in|sign in|unauthori[sz]ed|device not configured/i.test(message);
}

async function inspectExternalHarness(
  harness: ExternalHarness,
  dependencies: HarnessReadinessDependencies,
): Promise<HarnessReadinessEntry> {
  let executable: ExecutableProbe;
  try {
    executable = await dependencies.probeExecutable(harness);
  } catch (error) {
    return unavailableEntry(
      harness,
      "unavailable",
      `${LABELS[harness]} could not be checked: ${errorMessage(error)}`,
      { kind: "repair", label: `Check ${LABELS[harness]} installation` },
    );
  }
  if (!executable.installed) {
    return unavailableEntry(
      harness,
      "not_installed",
      `${LABELS[harness]} is not installed on this Mac.`,
      INSTALL_ACTIONS[harness],
    );
  }

  let authenticated: boolean;
  try {
    authenticated = await dependencies.hasAuthentication(harness);
  } catch (error) {
    return unavailableEntry(
      harness,
      "unavailable",
      `${LABELS[harness]} credentials could not be checked: ${errorMessage(error)}`,
      { kind: "repair", label: `Check ${LABELS[harness]} credentials` },
      executable.version,
    );
  }
  if (!authenticated) {
    return unavailableEntry(
      harness,
      "sign_in_required",
      `${LABELS[harness]} is installed but not signed in.`,
      SIGN_IN_ACTIONS[harness],
      executable.version,
    );
  }

  try {
    await dependencies.loadCatalog(harness);
  } catch (error) {
    const message = errorMessage(error);
    if (looksLikeAuthenticationFailure(message)) {
      return unavailableEntry(
        harness,
        "sign_in_required",
        `${LABELS[harness]} is installed but not signed in.`,
        SIGN_IN_ACTIONS[harness],
        executable.version,
      );
    }
    return unavailableEntry(
      harness,
      "setup_required",
      `${LABELS[harness]} needs setup before Cohub can use it.`,
      { kind: "repair", label: `Open ${LABELS[harness]} once to finish setup` },
      executable.version,
    );
  }

  return {
    harness,
    label: LABELS[harness],
    state: "ready",
    bundled: false,
    ...(executable.version ? { version: executable.version } : {}),
    detail: `${LABELS[harness]} is ready on this Mac.`,
  };
}

function harnessCommand(harness: ExternalHarness) {
  if (harness === "cursor") {
    return process.env.CURSOR_AGENT_COMMAND?.trim() || "agent";
  }
  return harness === "codex" ? "codex" : "grok";
}

async function probeExecutable(harness: ExternalHarness): Promise<ExecutableProbe> {
  const command = harnessCommand(harness);
  const candidates = isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return { installed: true };
    } catch (error) {
      const code = object(error)?.code;
      if (code !== "ENOENT" && code !== "EACCES") throw error;
    }
  }
  return { installed: false };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

async function readJsonObject(path: string) {
  try {
    return object(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    const code = object(error)?.code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

async function hasAuthentication(harness: ExternalHarness) {
  const home = homedir();
  if (harness === "codex") {
    const root = await readJsonObject(
      join(process.env.CODEX_HOME?.trim() || join(home, ".codex"), "auth.json"),
    );
    const tokens = object(root?.tokens);
    return Boolean(
      hasNonEmptyString(root?.OPENAI_API_KEY) ||
      hasNonEmptyString(tokens?.access_token) ||
      hasNonEmptyString(tokens?.refresh_token),
    );
  }
  if (harness === "grok_build") {
    const root = await readJsonObject(
      join(process.env.GROK_HOME?.trim() || join(home, ".grok"), "auth.json"),
    );
    return Boolean(
      root && Object.values(root).some((value) => {
        const credential = object(value);
        return hasNonEmptyString(credential?.key) ||
          hasNonEmptyString(credential?.refresh_token);
      }),
    );
  }
  const root = await readJsonObject(join(home, ".cursor", "cli-config.json"));
  const authInfo = object(root?.authInfo);
  return Boolean(
    authInfo &&
    (hasNonEmptyString(authInfo.authId) ||
      typeof authInfo.userId === "number"),
  );
}

export const systemHarnessReadinessService = createHarnessReadinessService({
  probeExecutable,
  hasAuthentication,
  loadCatalog: async (harness) => {
    const entries = await loadExternalHarnessCatalog(harness);
    if (
      harness === "cursor" &&
      entries.every((entry) => entry.model.catalogSource === "bundled")
    ) {
      throw new Error("Cursor has not completed local model discovery");
    }
    return entries;
  },
});

export function createHarnessReadinessService(
  dependencies: HarnessReadinessDependencies,
) {
  const now = dependencies.now ?? Date.now;
  const ttlMs = dependencies.ttlMs ?? 5 * 60_000;
  let cached: { expiresAt: number; value: HarnessReadinessResponse } | null = null;
  let inflight: Promise<HarnessReadinessResponse> | null = null;

  async function refresh() {
    const external = AGENT_HARNESSES.filter(
      (harness): harness is ExternalHarness => harness !== "pi",
    );
    const checkedAtMs = now();
    const harnesses = await Promise.all(
      external.map((harness) => inspectExternalHarness(harness, dependencies)),
    );
    const value: HarnessReadinessResponse = {
      checkedAt: new Date(checkedAtMs).toISOString(),
      harnesses: [
        {
          harness: "pi",
          label: "Pi",
          state: "ready",
          bundled: true,
          detail: "Pi is included with Cohub Connector.",
        },
        ...harnesses,
      ],
    };
    cached = { expiresAt: checkedAtMs + ttlMs, value };
    return value;
  }

  return {
    list(options: { force?: boolean } = {}) {
      if (!options.force && cached && cached.expiresAt > now()) {
        return Promise.resolve(cached.value);
      }
      if (inflight) return inflight;
      inflight = refresh().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    clear() {
      cached = null;
    },
  };
}
