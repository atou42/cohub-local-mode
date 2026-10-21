import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { SandboxImageId, SandboxPreferenceSpec, SandboxPreferences, SandboxPreferenceSource } from "@cohub/protocol/sandbox";
export type { SandboxImageId, SandboxPreferenceSpec, SandboxPreferences, SandboxPreferenceSource } from "@cohub/protocol/sandbox";

export const SANDBOX_CONFIG_PATH = ".cohub/sandbox.json";
export const SANDBOX_IMAGES = ["default", "game"] as const;
export const SANDBOX_SPEC_IDS = ["standard", "boost", "ultra"] as const;

export function parseSandboxPreferences(value: unknown, file = false): SandboxPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid sandbox preferences");
  const record = value as Record<string, unknown>;
  const keys = file ? ["version", "image", "spec"] : ["image", "spec"];
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new Error("Unknown sandbox preference field");
  if (file && record.version !== 1) throw new Error("Unsupported sandbox config version");
  if (record.image !== undefined && !SANDBOX_IMAGES.includes(record.image as SandboxImageId)) throw new Error("Unknown sandbox image");
  if (record.spec !== undefined && !SANDBOX_SPEC_IDS.includes(record.spec as SandboxPreferenceSpec)) throw new Error("Unknown sandbox spec");
  return {
    ...(record.image !== undefined ? { image: record.image as SandboxImageId } : {}),
    ...(record.spec !== undefined ? { spec: record.spec as SandboxPreferenceSpec } : {}),
  };
}

export function resolveSandboxPreferences(input: {
  sources: SandboxPreferenceSource[];
  images: Partial<Record<SandboxImageId, string>> & { default: string };
  allowedSpec: SandboxPreferenceSpec;
  strict?: boolean;
}) {
  const requested: Required<SandboxPreferences> = { image: "default", spec: "standard" };
  const origins = { image: "platform", spec: "platform" };
  for (const item of input.sources) {
    if (item.preferences.image) {
      requested.image = item.preferences.image;
      origins.image = item.source;
    }
    if (item.preferences.spec) {
      requested.spec = item.preferences.spec;
      origins.spec = item.source;
    }
  }
  const errors = input.sources.filter((source) => source.error);
  if (input.strict && errors.length && !(origins.image === "override" && origins.spec === "override")) {
    throw new Error(errors.map((source) => `${source.source}: ${source.error}`).join("; "));
  }
  const effective = { ...requested };
  const warnings: string[] = [];
  if (!input.images[effective.image]) {
    effective.image = "default";
    warnings.push("image_unavailable");
  }
  if (SANDBOX_SPEC_IDS.indexOf(effective.spec) > SANDBOX_SPEC_IDS.indexOf(input.allowedSpec)) {
    effective.spec = input.allowedSpec;
    warnings.push("spec_entitlement_limited");
  }
  const imageRef = input.images[effective.image] ?? input.images.default;
  const fingerprint = createHash("sha256").update(JSON.stringify({ effective, imageRef })).digest("hex");
  return { requested, effective, origins, warnings, imageRef, fingerprint, sources: input.sources };
}

export async function readSandboxPreferences(root: string, source: string): Promise<SandboxPreferenceSource> {
  let path: string;
  try {
    const base = await realpath(root);
    path = await realpath(resolve(base, SANDBOX_CONFIG_PATH));
    const suffix = relative(base, path);
    if (suffix.startsWith("..") || isAbsolute(suffix)) throw new Error("Sandbox config must remain inside its workspace");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { source, preferences: {} };
    throw error;
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 16_384) throw new Error("Sandbox config must be a file of at most 16 KiB");
    const buffer = Buffer.alloc(16_385);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (bytesRead > 16_384 || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error("Sandbox config changed while reading; retry");
    const raw = buffer.subarray(0, bytesRead).toString("utf8");
    return { source, preferences: parseSandboxPreferences(JSON.parse(raw), true), revision: createHash("sha256").update(raw).digest("hex") };
  } catch (error) {
    throw new Error(`Invalid sandbox config (${source}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    await handle.close();
  }
}
