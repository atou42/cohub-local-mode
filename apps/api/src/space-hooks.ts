import {
  SPACE_HOOKS_DIR,
  getSpaceHooksRedisKey,
} from "@cohub/protocol";
import {
  createCachedSpaceHooksConfig,
  isSpaceHookFileName,
  parseSpaceHookDefinition,
  peekSpaceHookDefinitions,
  resolveSpaceHooksCacheTtlSec,
  type SpaceHookDefinition,
} from "@cohub/core/hooks";
import { createLogger } from "@cohub/infra/logging";
import { redisCommandClient } from "./redis.js";
import { SpaceFsError } from "./space-fs.js";
import { listSpaceDirectory, readSpaceFiles } from "./space-fs-backend.js";

const logger = createLogger({ serviceName: "cohub-api" });

/**
 * Hook definitions for a space, provider-aware.
 *
 * Reads the shared Redis cache first (same key the worker fills). On a miss
 * it loads through the space fs facade — cloud PVC or local sandbox relay —
 * and refills the cache so the worker benefits too.
 */
export async function loadSpaceHookDefinitionsForApi(spaceId: string): Promise<{
  definitions: SpaceHookDefinition[];
  cache: "hit" | "miss";
}> {
  const peeked = await peekSpaceHookDefinitions({ spaceId, redis: redisCommandClient });
  if (peeked.status === "hit") return { definitions: peeked.definitions, cache: "hit" };

  const definitions = await readHookDefinitionsFromSpaceFs(spaceId);
  await redisCommandClient
    .set(
      getSpaceHooksRedisKey(spaceId),
      JSON.stringify(createCachedSpaceHooksConfig({ spaceId, definitions })),
      "EX",
      resolveSpaceHooksCacheTtlSec(definitions.length),
    )
    .catch(() => undefined);
  return { definitions, cache: "miss" };
}

async function readHookDefinitionsFromSpaceFs(spaceId: string): Promise<SpaceHookDefinition[]> {
  let entries: Awaited<ReturnType<typeof listSpaceDirectory>>["entries"];
  try {
    entries = (await listSpaceDirectory(spaceId, SPACE_HOOKS_DIR, { visibility: "full" })).entries;
  } catch (error) {
    if (error instanceof SpaceFsError && error.status === 404) return [];
    throw error;
  }

  const paths = entries
    .filter((entry) => entry.type === "file" && isSpaceHookFileName(entry.name))
    .map((entry) => `${SPACE_HOOKS_DIR}/${entry.name}`)
    .sort();
  if (paths.length === 0) return [];

  const files: Awaited<ReturnType<typeof readSpaceFiles>>["files"] = [];
  const readChunk = 50;
  for (let index = 0; index < paths.length; index += readChunk) {
    const batch = await readSpaceFiles(spaceId, paths.slice(index, index + readChunk), { visibility: "full" });
    files.push(...batch.files);
  }
  const definitions: SpaceHookDefinition[] = [];
  for (const file of files) {
    const raw = file.encoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
    try {
      definitions.push(parseSpaceHookDefinition(raw, file.path));
    } catch (error) {
      logger.warn("[SpaceHooks] skipping invalid hook file", {
        spaceId,
        path: file.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return definitions;
}
