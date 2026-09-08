import {
  AGENT_HARNESSES,
  type AgentHarness,
  type HarnessReadinessAction,
  type HarnessReadinessEntry,
  type HarnessReadinessResponse,
} from "@cohub/protocol";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { loadExternalHarnessCatalog } from "./harness-catalog.js";
import { isExplicitSignOut, probeCliAuthentication } from "./harness-auth.js";

type ExternalHarness = Exclude<AgentHarness, "pi">;

type ExecutableProbe = {
  installed: boolean;
  version?: string;
};

export type HarnessReadinessDependencies = {
  probeExecutable: (harness: ExternalHarness) => Promise<ExecutableProbe>;
  hasAuthentication: (harness: ExternalHarness) => Promise<boolean>;
  loadCatalog: (harness: ExternalHarness) => Promise<unknown>;
  hasConfiguredPiModel: (userId?: string) => Promise<boolean>;
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
      `${LABELS[harness]} CLI status could not be checked: ${errorMessage(error)}`,
      { kind: "repair", label: `Check ${LABELS[harness]} in Terminal` },
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
    if (isExplicitSignOut(message)) {
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

export const systemHarnessReadinessService = createHarnessReadinessService({
  probeExecutable,
  hasAuthentication: probeCliAuthentication,
  hasConfiguredPiModel: async (userId) => {
    const { CompletionModelRegistry, loadRuntimeModelsConfigs } = await import("../llm/models.js");
    const registry = new CompletionModelRegistry(await loadRuntimeModelsConfigs(userId));
    return registry.getAvailable().some((model) => Boolean(registry.getApiKey(model.provider)));
  },
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
  let cached: { userId?: string; expiresAt: number; value: HarnessReadinessResponse } | null = null;
  let inflight: { userId?: string; promise: Promise<HarnessReadinessResponse> } | null = null;

  async function inspectPi(userId?: string): Promise<HarnessReadinessEntry> {
    const base = { harness: "pi" as const, label: "Pi", bundled: true };
    try {
      if (await dependencies.hasConfiguredPiModel(userId)) {
        return { ...base, state: "ready", detail: "Pi has a configured local model provider." };
      }
      return {
        ...base, state: "setup_required",
        detail: "Pi is included, but no local model provider is configured. Choose a ready local CLI agent.",
      };
    } catch (error) {
      return { ...base, state: "unavailable", detail: `Pi model configuration could not be checked: ${errorMessage(error)}` };
    }
  }

  async function refresh(userId?: string) {
    const external = AGENT_HARNESSES.filter(
      (harness): harness is ExternalHarness => harness !== "pi",
    );
    const checkedAtMs = now();
    const harnesses = await Promise.all([
      inspectPi(userId),
      ...external.map((harness) => inspectExternalHarness(harness, dependencies)),
    ]);
    const value: HarnessReadinessResponse = {
      checkedAt: new Date(checkedAtMs).toISOString(),
      harnesses,
    };
    cached = { userId, expiresAt: checkedAtMs + ttlMs, value };
    return value;
  }

  return {
    list(options: { force?: boolean; userId?: string } = {}) {
      if (!options.force && cached && cached.userId === options.userId && cached.expiresAt > now()) {
        return Promise.resolve(cached.value);
      }
      if (inflight && inflight.userId === options.userId) return inflight.promise;
      const promise = refresh(options.userId).finally(() => {
        if (inflight?.promise === promise) inflight = null;
      });
      inflight = { userId: options.userId, promise };
      return promise;
    },
    clear() {
      cached = null;
    },
  };
}
