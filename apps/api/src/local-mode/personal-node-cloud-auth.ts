import { execFile } from "node:child_process";

const AUTH_SCHEMA_VERSION = 1;
const EXPIRY_SKEW_MS = 60_000;

type StoredCloudAuth = {
  schemaVersion: typeof AUTH_SCHEMA_VERSION;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  scope: string;
  updatedAt: number;
};

type ResolvePersonalNodeCloudAccessTokenInput = {
  forceRefresh: boolean;
  now?: number;
  readSecret: () => Promise<string | null>;
  writeSecret: (value: string) => Promise<void>;
  refresh: (refreshToken: string) => Promise<unknown>;
};

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new Error(`Personal Node cloud auth has an invalid ${field}`);
  }
  return value.trim();
}

function requiredPositiveNumber(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Personal Node cloud auth has an invalid ${field}`);
  }
  return value;
}

function parseStoredCloudAuth(value: unknown): StoredCloudAuth {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Personal Node cloud auth is invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== AUTH_SCHEMA_VERSION) {
    throw new Error("Personal Node cloud auth has an invalid schema version");
  }
  return {
    schemaVersion: AUTH_SCHEMA_VERSION,
    accessToken: requiredString(record.accessToken, "accessToken"),
    refreshToken: requiredString(record.refreshToken, "refreshToken"),
    accessTokenExpiresAt: requiredPositiveNumber(
      record.accessTokenExpiresAt,
      "accessTokenExpiresAt",
    ),
    scope: requiredString(record.scope, "scope"),
    updatedAt: requiredPositiveNumber(record.updatedAt, "updatedAt"),
  };
}

function parseRefreshPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Personal Node cloud auth refresh response is invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.status !== "complete" || record.tokenType !== "Bearer") {
    throw new Error("Personal Node cloud auth refresh response is invalid");
  }
  return {
    accessToken: requiredString(record.accessToken, "accessToken"),
    refreshToken:
      record.refreshToken === undefined
        ? null
        : requiredString(record.refreshToken, "refreshToken"),
    expiresInSeconds: requiredPositiveNumber(
      record.expiresInSeconds,
      "expiresInSeconds",
    ),
    scope: requiredString(record.scope, "scope"),
  };
}

export async function resolvePersonalNodeCloudAccessToken(
  input: ResolvePersonalNodeCloudAccessTokenInput,
) {
  const raw = await input.readSecret();
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("Personal Node cloud auth is invalid JSON", { cause: error });
  }
  const stored = parseStoredCloudAuth(parsed);
  const now = input.now ?? Date.now();
  if (
    !input.forceRefresh &&
    stored.accessTokenExpiresAt > now + EXPIRY_SKEW_MS
  ) {
    return stored.accessToken;
  }

  const refreshed = parseRefreshPayload(await input.refresh(stored.refreshToken));
  const next: StoredCloudAuth = {
    schemaVersion: AUTH_SCHEMA_VERSION,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? stored.refreshToken,
    accessTokenExpiresAt: now + refreshed.expiresInSeconds * 1_000,
    scope: refreshed.scope,
    updatedAt: now,
  };
  await input.writeSecret(JSON.stringify(next));
  return next.accessToken;
}

function runSecurity(args: string[], missingIsNull = false) {
  return new Promise<string | null>((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      args,
      { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout.trim());
          return;
        }
		const code = Reflect.get(error, "code") as unknown;
        if (missingIsNull && (code === 44 || code === "44")) {
          resolve(null);
          return;
        }
        reject(
          new Error(
            `macOS Keychain request failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
            { cause: error },
          ),
        );
      },
    );
  });
}

async function refreshCloudAuth(origin: string, refreshToken: string) {
  const response = await fetch(`${origin}/api/alpha/v1/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      typeof Reflect.get(payload, "message") === "string"
        ? Reflect.get(payload, "message")
        : `Personal Node cloud auth refresh returned HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

export async function resolvePersonalNodeCloudAccessTokenFromEnvironment(
  forceRefresh: boolean,
) {
  const service =
    process.env.COHUB_PERSONAL_NODE_AUTH_KEYCHAIN_SERVICE?.trim() ?? "";
  const account =
    process.env.COHUB_PERSONAL_NODE_AUTH_KEYCHAIN_ACCOUNT?.trim() ?? "";
  const origin = process.env.COHUB_PERSONAL_NODE_AUTH_ORIGIN?.trim() ?? "";
  if (!service && !account && !origin) return undefined;
  if (!service || !account || !origin || new URL(origin).protocol !== "https:") {
    throw new Error("Personal Node cloud auth environment is invalid");
  }
  const normalizedOrigin = origin.replace(/\/+$/, "");
  return resolvePersonalNodeCloudAccessToken({
    forceRefresh,
    readSecret: () =>
      runSecurity(
        ["find-generic-password", "-w", "-s", service, "-a", account],
        true,
      ),
    writeSecret: async (value) => {
      await runSecurity([
        "add-generic-password",
        "-U",
        "-s",
        service,
        "-a",
        account,
        "-w",
        value,
      ]);
    },
    refresh: (refreshToken) => refreshCloudAuth(normalizedOrigin, refreshToken),
  });
}
