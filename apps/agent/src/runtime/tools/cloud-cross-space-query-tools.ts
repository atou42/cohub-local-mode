import { posix } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import picomatch from "picomatch";
import { getCurrentToolExecutionContext } from "../../tool-context.js";
import { createFindTool, createLsTool, createReadTool, type FindOperations, type GrepToolInput, type LsOperations, type ReadOperations } from "./index.js";
import { createGrepToolDefinition } from "./index.js";
import { listCloudSpaceDirectory, readCloudSpaceFile } from "../cloud-space-api.js";

const WORKSPACE = "/workspace";
const MAX_WALK_ENTRIES = 2_000;
const MAX_GREP_BYTES = 20 * 1024 * 1024;

function currentSpaceId() {
  const spaceId = getCurrentToolExecutionContext()?.spaceId;
  if (!spaceId) throw new Error("Tool execution context is missing spaceId");
  return spaceId;
}

function relativePath(input?: string) {
  const raw = input?.trim() || ".";
  const normalized = posix.normalize(raw.startsWith("/") ? raw : `${WORKSPACE}/${raw}`);
  if (normalized !== WORKSPACE && !normalized.startsWith(`${WORKSPACE}/`)) {
    throw new Error("Path must stay within /workspace.");
  }
  return normalized === WORKSPACE ? "" : normalized.slice(WORKSPACE.length + 1);
}

function fileBuffer(file: Awaited<ReturnType<typeof readCloudSpaceFile>>) {
  return Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
}

async function walkFiles(root: string, limit = MAX_WALK_ENTRIES) {
  const queue = [root];
  const files: string[] = [];
  let visited = 0;
  while (queue.length > 0 && visited < limit) {
    const directory = queue.shift() ?? "";
    const tree = await listCloudSpaceDirectory(currentSpaceId(), directory);
    for (const entry of tree.entries) {
      visited += 1;
      if (entry.path === ".git" || entry.path.startsWith(".git/")) continue;
      if (entry.type === "dir") queue.push(entry.path);
      else if (entry.type === "file") files.push(entry.path);
      if (visited >= limit) break;
    }
  }
  return { files, partial: queue.length > 0 };
}

export function createCloudCrossSpaceReadTool(): AgentTool {
  const operations: ReadOperations = {
    async readFile(path) {
      return fileBuffer(await readCloudSpaceFile(currentSpaceId(), relativePath(path)));
    },
    async access(path) {
      await readCloudSpaceFile(currentSpaceId(), relativePath(path));
    },
    async detectImageMimeType(path) {
      const file = await readCloudSpaceFile(currentSpaceId(), relativePath(path));
      return file.mimeType?.startsWith("image/") ? file.mimeType : null;
    },
  };
  return createReadTool(WORKSPACE, { operations });
}

export function createCloudCrossSpaceLsTool(): AgentTool {
  const operations: LsOperations = {
    async exists(path) {
      try {
        await listCloudSpaceDirectory(currentSpaceId(), relativePath(path));
        return true;
      } catch {
        return false;
      }
    },
    async stat() {
      return { isDirectory: () => true };
    },
    async readdir(path) {
      const tree = await listCloudSpaceDirectory(currentSpaceId(), relativePath(path));
      return tree.entries
        .map((entry) => `${entry.name}${entry.type === "dir" ? "/" : ""}`)
        .sort((left, right) => left.localeCompare(right));
    },
  };
  return createLsTool(WORKSPACE, { operations });
}

export function createCloudCrossSpaceFindTool(): AgentTool {
  const operations: FindOperations = {
    async exists(path) {
      try {
        await listCloudSpaceDirectory(currentSpaceId(), relativePath(path));
        return true;
      } catch {
        return false;
      }
    },
    async glob(pattern, cwd, options) {
      const root = relativePath(cwd);
      const walked = await walkFiles(root);
      const matcher = picomatch(pattern.includes("/") ? pattern : `**/${pattern}`, { dot: true });
      const matches = walked.files
        .filter((path) => matcher(root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path))
        .slice(0, options.limit);
      return {
        matches,
        ...(walked.partial ? { note: `Cloud search stopped after ${MAX_WALK_ENTRIES} entries`, details: { partial: true } } : {}),
      };
    },
  };
  return createFindTool(WORKSPACE, { operations });
}

export function createCloudCrossSpaceGrepTool(): AgentTool {
  const tool = createGrepToolDefinition(WORKSPACE);
  tool.parameters = Type.Object({
    pattern: Type.String({ description: "Search pattern" }),
    path: Type.Optional(Type.String({ description: "Directory or file to search" })),
    glob: Type.Optional(Type.String({ description: "File glob filter" })),
    ignoreCase: Type.Optional(Type.Boolean(),),
    literal: Type.Optional(Type.Boolean()),
    context: Type.Optional(Type.Number()),
    limit: Type.Optional(Type.Number()),
  });
  tool.execute = async (_toolCallId, input, signal) => {
    const params = input as GrepToolInput;
    const root = relativePath(params.path);
    const walked = await walkFiles(root);
    const glob = params.glob?.trim() ? picomatch(params.glob.trim(), { dot: true }) : null;
    let expression: RegExp;
    try {
      expression = new RegExp(params.literal ? params.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : params.pattern, params.ignoreCase ? "i" : "");
    } catch (error) {
      throw new Error(`Invalid search pattern: ${error instanceof Error ? error.message : String(error)}`);
    }
    const output: string[] = [];
    const limit = Math.max(1, params.limit ?? 100);
    let bytes = 0;
    let partial = walked.partial;
    for (const path of walked.files) {
      if (signal?.aborted) throw new Error("Operation aborted");
      if (glob && !glob(path)) continue;
      const file = await readCloudSpaceFile(currentSpaceId(), path, signal);
      if (file.kind !== "text") continue;
      bytes += file.size;
      if (bytes > MAX_GREP_BYTES) {
        partial = true;
        break;
      }
      const lines = file.content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (!expression.test(lines[index] ?? "")) continue;
        output.push(`${path}:${index + 1}:${lines[index] ?? ""}`);
        if (output.length >= limit) break;
      }
      if (output.length >= limit) break;
    }
    const note = partial ? `\n\n[Cloud search was bounded at ${MAX_WALK_ENTRIES} entries or ${MAX_GREP_BYTES} bytes.]` : "";
    return { content: [{ type: "text", text: `${output.join("\n")}${note}` }], details: partial ? { partial: true } : undefined };
  };
  return tool;
}
