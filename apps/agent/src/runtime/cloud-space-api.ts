import {
  createCohubClient,
  HttpError,
  type SpaceFsFileResponse,
  type SpaceFsPreparingFile,
} from "@neta-art/cohub";
import { resolveAccessToken } from "@neta-art/cohub-cli/auth";
import { env } from "../env.js";
import { getCurrentToolExecutionContext } from "../tool-context.js";
import { createCloudSpaceFileVisibilityResolver } from "./cloud-space-access.js";

const client = createCohubClient({
  baseUrl: env.CLOUD_API_BASE_URL,
  getAccessToken: (options) => resolveAccessToken({ forceRefresh: options?.forceRefresh }),
  requestSource: () => {
    const context = getCurrentToolExecutionContext();
    if (!context) return null;
    return {
      spaceId: context.sourceSpaceId ?? context.spaceId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: context.toolCallId,
      clientId: context.sourceClientId ?? undefined,
      via: "tool",
    };
  },
});

type CloudFile = SpaceFsFileResponse | SpaceFsPreparingFile;
const fileCache = new Map<string, { value: CloudFile; expiresAt: number }>();
const CLOUD_FILE_CACHE_TTL_MS = 5_000;
const CLOUD_FILE_CACHE_LIMIT = 64;

function cloudError(error: unknown, action: string): never {
  if (error instanceof HttpError) {
    if (error.status === 401) throw new Error("Cloud account is not connected or its session expired.");
    if (error.status === 403) throw new Error("Cloud Space file access denied.");
    if (error.status === 404) throw new Error("Cloud Space file not found.");
  }
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`Cloud Space ${action} failed: ${message}`);
}

export const resolveCloudSpaceFileVisibility = createCloudSpaceFileVisibilityResolver({
  getMe: () => client.user.getMe(),
  getSpace: (spaceId) => client.spaces.get(spaceId),
});

export async function listCloudSpaceDirectory(spaceId: string, path: string) {
  try {
    return await client.space(spaceId).files.list(path);
  } catch (error) {
    cloudError(error, "directory read");
  }
}

export async function readCloudSpaceFile(spaceId: string, path: string, signal?: AbortSignal) {
  const cacheKey = `${spaceId}:${path}`;
  const cached = fileCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() && "content" in cached.value) {
    return cached.value;
  }
  if (cached) fileCache.delete(cacheKey);
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (signal?.aborted) throw new Error("Operation aborted");
    try {
      const result = await client.space(spaceId).files.read(path, undefined, signal);
      if ("content" in result) {
        fileCache.set(cacheKey, {
          value: result,
          expiresAt: Date.now() + CLOUD_FILE_CACHE_TTL_MS,
        });
        while (fileCache.size > CLOUD_FILE_CACHE_LIMIT) {
          const oldest = fileCache.keys().next().value;
          if (typeof oldest !== "string") break;
          fileCache.delete(oldest);
        }
        return result;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Cloud file is still being prepared: ${path}`);
      }
      const waitMs = Math.max(250, Math.min(result.retryAfterMs, 2_000));
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const timeout = setTimeout(finish, waitMs);
        const abort = () => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
          reject(new Error("Operation aborted"));
        };
        signal?.addEventListener("abort", abort, { once: true });
      });
    } catch (error) {
      if (error instanceof Error && (error.message === "Operation aborted" || error.message.startsWith("Cloud file is still"))) throw error;
      cloudError(error, "file read");
    }
  }
}
