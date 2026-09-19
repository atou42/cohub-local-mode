import { resolveAccessToken } from "@neta-art/cohub-cli/auth";
import type { PublicGenerationDeclaration } from "@cohub/infra/config-runtime/generation-declarations";
import { config } from "../config.js";

const ACCOUNT_CACHE_TTL_MS = 60_000;
const MODEL_CACHE_TTL_MS = 60_000;

type CloudModelsResponse = { models?: unknown };

let accountCache: { token: string; userId: string; expiresAt: number } | null = null;
let modelsCache: { userId: string; models: PublicGenerationDeclaration[]; expiresAt: number } | null = null;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

function isPublicGenerationDeclaration(value: unknown): value is PublicGenerationDeclaration {
  const record = asRecord(value);
  return typeof record?.model === "string" && record.model.trim().length > 0;
}

function responseMessage(body: unknown, fallback: string): string {
  const record = asRecord(body);
  return typeof record?.message === "string" && record.message.trim()
    ? record.message.trim()
    : fallback;
}

async function getCloudToken(userId: string, forceRefresh = false): Promise<string> {
  const token = await resolveAccessToken({ forceRefresh }).catch((error) => {
    throw new Error(`Cloud account authentication failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!token) throw new Error("Cloud account is not connected. Run cohub auth login on the host.");
  if (!forceRefresh && accountCache?.token === token && accountCache.userId === userId && accountCache.expiresAt > Date.now()) {
    return token;
  }

  const response = await fetch(new URL("/api/me", config.cloudApiOrigin), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 401 && !forceRefresh) return getCloudToken(userId, true);
  if (!response.ok) throw new Error(`Cloud account verification returned HTTP ${response.status}.`);
  const body = await response.json().catch(() => null) as { uuid?: unknown } | null;
  if (body?.uuid !== userId) throw new Error("The connected cloud account does not match this Cohub user.");
  accountCache = { token, userId, expiresAt: Date.now() + ACCOUNT_CACHE_TTL_MS };
  return token;
}

export async function loadCloudGenerationModels(userId: string, forceRefresh = false): Promise<PublicGenerationDeclaration[]> {
  if (!forceRefresh && modelsCache?.userId === userId && modelsCache.expiresAt > Date.now()) return modelsCache.models;
  let token = await getCloudToken(userId, forceRefresh);
  let response = await fetch(new URL("/api/models?modelType=multimodal", config.cloudApiOrigin), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 401 && !forceRefresh) {
    accountCache = null;
    token = await getCloudToken(userId, true);
    response = await fetch(new URL("/api/models?modelType=multimodal", config.cloudApiOrigin), {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
  const body = await response.json().catch(() => null) as CloudModelsResponse | null;
  if (!response.ok) throw new Error(responseMessage(body, `Cloud generation models returned HTTP ${response.status}.`));
  if (!Array.isArray(body?.models) || !body.models.every(isPublicGenerationDeclaration)) {
    throw new Error("Cloud generation models returned an invalid response.");
  }
  modelsCache = { userId, models: body.models, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
  return body.models;
}

export async function loadCloudGenerationModel(userId: string, model: string): Promise<PublicGenerationDeclaration | null> {
  const models = await loadCloudGenerationModels(userId);
  return models.find((entry) => entry.model === model) ?? null;
}
