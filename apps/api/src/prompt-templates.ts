import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createCachedPromptTemplatesConfig,
  getModPromptsRedisKey,
  getSpaceModPromptsRedisKey,
  getUserPromptsRedisKey,
  loadPromptTemplatesFromDirectory,
  mergePromptTemplatesConfigs,
  parseCachedPromptTemplatesConfig,
  PLATFORM_PROMPTS_REDIS_KEY,
  PROMPTS_CACHE_TTL_SEC,
  type CachedPromptTemplatesConfig,
  type PromptTemplate,
  type PromptTemplateCatalogEntry,
  type PromptTemplatesConfig,
  type PromptTemplateScope,
} from "@cohub/infra/config-runtime/prompts";
import { getSpaceModMountSignature, listEnabledSpaceMods } from "@cohub/core/space-mods";
import { parsePromptCommand, renderPromptTemplate } from "@cohub/core/sessions";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { redisCommandClient } from "./redis.js";

export type { PromptTemplateCatalogEntry } from "@cohub/infra/config-runtime/prompts";

export type ExpandedPromptTemplate = {
  renderedText: string;
  template: PromptTemplateCatalogEntry;
  args: string[];
  rawInput: string;
};

export type LoadPromptTemplatesOptions = {
  userId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
};

const PROMPTS_DIR = ".agents/prompts";
const CHECKPOINT_META_PATH = ".cohub/system/checkpoint-meta.v1.json";

const inflightByCacheKey = new Map<string, Promise<PromptTemplatesConfig | null>>();

function getPlatformPromptsDir() {
  return join(config.platformConfigRoot, "platform", PROMPTS_DIR);
}

function getUserPromptsDir(userId: string) {
  return join(config.platformConfigRoot, "users", userId, PROMPTS_DIR);
}

function getProjectPromptsDir(spaceId: string) {
  return resolve(config.spaceStorageRoot, spaceId, "workspace", PROMPTS_DIR);
}

async function loadProjectPrompts(spaceId: string): Promise<PromptTemplatesConfig> {
  const { content } = await loadPromptTemplatesFromDirectory({
    dir: getProjectPromptsDir(spaceId),
    scope: "project",
    allowMissing: true,
  });
  return content;
}

function getModLatestDir(modSpaceId: string) {
  return resolve(config.checkpointCacheRoot, modSpaceId, "latest");
}

function getModPromptsDir(modSpaceId: string) {
  return resolve(getModLatestDir(modSpaceId), PROMPTS_DIR);
}

async function getDirectoryRevision(dir: string): Promise<string> {
  for (const path of [join(dir, CHECKPOINT_META_PATH), dir]) {
    try {
      const stats = await stat(path);
      return `${path}:${Math.trunc(stats.mtimeMs)}:${stats.size}`;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
      if (code !== "ENOENT") throw error;
    }
  }
  return `${dir}:missing`;
}

async function loadPromptsFromDir(input: {
  dir: string;
  redisKey: string;
  scope: PromptTemplateScope;
  allowMissing: boolean;
}): Promise<CachedPromptTemplatesConfig> {
  try {
    const { rawText, content } = await loadPromptTemplatesFromDirectory(input);
    const cached = createCachedPromptTemplatesConfig({ rawText, content });
    await redisCommandClient.set(input.redisKey, JSON.stringify(cached), "EX", PROMPTS_CACHE_TTL_SEC).catch(() => undefined);
    return cached;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
    if (code !== "ENOENT" || !input.allowMissing) throw error;
    const cached = createCachedPromptTemplatesConfig({ rawText: "", content: { templates: [] } });
    await redisCommandClient.set(input.redisKey, JSON.stringify(cached), "EX", PROMPTS_CACHE_TTL_SEC).catch(() => undefined);
    return cached;
  }
}

async function loadCachedPrompts(input: {
  redisKey: string;
  dir: string;
  scope: PromptTemplateScope;
  allowMissing: boolean;
}): Promise<PromptTemplatesConfig | null> {
  const inflight = inflightByCacheKey.get(input.redisKey);
  if (inflight) return inflight;

  const promise = (async () => {
    const cached = await redisCommandClient.get(input.redisKey).catch(() => null);
    if (cached) {
      const parsed = parseCachedPromptTemplatesConfig(cached);
      if (parsed) return parsed.content;
    }
    return (await loadPromptsFromDir(input)).content;
  })();

  inflightByCacheKey.set(input.redisKey, promise);
  try {
    return await promise;
  } finally {
    inflightByCacheKey.delete(input.redisKey);
  }
}

async function loadSpaceModPrompts(spaceId: string): Promise<PromptTemplatesConfig | null> {
  const mods = await listEnabledSpaceMods(db, spaceId);
  if (mods.length === 0) return null;

  const signature = getSpaceModMountSignature(mods);
  const sources = await Promise.all(mods.map(async (mod) => ({
    mod,
    promptsDir: getModPromptsDir(mod.modSpaceId),
    revision: await getDirectoryRevision(getModLatestDir(mod.modSpaceId)),
  })));
  const aggregateKey = getSpaceModPromptsRedisKey(
    spaceId,
    JSON.stringify({ signature, revisions: sources.map((source) => [source.mod.modSpaceId, source.revision]) }),
  );

  const cached = await redisCommandClient.get(aggregateKey).catch(() => null);
  if (cached) {
    const parsed = parseCachedPromptTemplatesConfig(cached);
    if (parsed) return parsed.content;
  }

  const configs = await Promise.all(sources.map((source) => loadCachedPrompts({
    redisKey: getModPromptsRedisKey(source.mod.modSpaceId, source.revision),
    dir: source.promptsDir,
    scope: "mod",
    allowMissing: true,
  })));
  const content = mergePromptTemplatesConfigs(...configs);
  const aggregate = createCachedPromptTemplatesConfig({ rawText: aggregateKey, content });
  await redisCommandClient.set(aggregateKey, JSON.stringify(aggregate), "EX", PROMPTS_CACHE_TTL_SEC).catch(() => undefined);
  return content;
}

async function fetchPromptTemplates(options: LoadPromptTemplatesOptions): Promise<PromptTemplate[]> {
  const platformPrompts = await loadCachedPrompts({
    redisKey: PLATFORM_PROMPTS_REDIS_KEY,
    dir: getPlatformPromptsDir(),
    scope: "platform",
    allowMissing: true,
  });

  const configs: Array<PromptTemplatesConfig | null> = [platformPrompts];

  if (options.spaceId) {
    configs.push(await loadSpaceModPrompts(options.spaceId));
  }

  if (options.userId) {
    configs.push(await loadCachedPrompts({
      redisKey: getUserPromptsRedisKey(options.userId),
      dir: getUserPromptsDir(options.userId),
      scope: "user",
      allowMissing: true,
    }));
  }

  if (options.spaceId && config.spaceStorageRoot) {
    configs.push(await loadProjectPrompts(options.spaceId));
  }

  return mergePromptTemplatesConfigs(...configs).templates;
}

export async function listPromptTemplates(options: LoadPromptTemplatesOptions = {}): Promise<PromptTemplateCatalogEntry[]> {
  const templates = await fetchPromptTemplates(options);
  return templates.map((template) => ({
    name: template.name,
    description: template.description,
    argumentHint: template.argumentHint,
    category: template.category,
    quickAction: template.quickAction,
    buttonLabel: template.buttonLabel,
    order: template.order,
    scope: template.scope,
  }));
}

export async function expandPromptTemplate(text: string, options: LoadPromptTemplatesOptions = {}): Promise<ExpandedPromptTemplate | null> {
  const command = text.startsWith("/skill:") ? null : parsePromptCommand(text);
  if (!command) return null;
  const template = (await fetchPromptTemplates(options)).find((item) => item.name === command.name);
  if (!template) return null;
  return {
    renderedText: renderPromptTemplate(template.content, command, {
      sessionId: options.sessionId,
      spaceId: options.spaceId,
      userUuid: options.userId,
    }),
    template: {
      name: template.name,
      description: template.description,
      argumentHint: template.argumentHint,
      category: template.category,
      quickAction: template.quickAction,
      buttonLabel: template.buttonLabel,
      order: template.order,
      scope: template.scope,
    },
    args: command.args,
    rawInput: text,
  };
}
