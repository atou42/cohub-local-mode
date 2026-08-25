import type { ContentBlock } from "@cohub/protocol/core";

export type AgentSpaceOrigin = "cloud" | "local";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function collectSpaceMentionOrigins(
  content: ContentBlock[],
): Record<string, AgentSpaceOrigin> {
  const origins: Record<string, AgentSpaceOrigin> = {};
  for (const block of content) {
    const mentions = block._meta?.mentions;
    if (mentions === undefined) continue;
    if (!Array.isArray(mentions)) {
      throw new Error("Space mention metadata is invalid: mentions must be an array");
    }
    for (const rawMention of mentions) {
      const mention = record(rawMention);
      if (mention?.type !== "space" || typeof mention.spaceId !== "string") continue;
      if (mention.origin === undefined) continue;
      if (mention.origin !== "cloud" && mention.origin !== "local") {
        throw new Error(`Space mention ${mention.spaceId} has an invalid origin`);
      }
      const previous = origins[mention.spaceId];
      if (previous && previous !== mention.origin) {
        throw new Error(`Space mention ${mention.spaceId} has conflicting origins`);
      }
      origins[mention.spaceId] = mention.origin;
    }
  }
  return origins;
}

export function mergeSpaceMentionOrigins(
  contents: ContentBlock[][],
): Record<string, AgentSpaceOrigin> {
  const merged: Record<string, AgentSpaceOrigin> = {};
  for (const content of contents) {
    const origins = collectSpaceMentionOrigins(content);
    for (const [spaceId, origin] of Object.entries(origins)) {
      const previous = merged[spaceId];
      if (previous && previous !== origin) {
        throw new Error(`Space mention ${spaceId} has conflicting origins`);
      }
      merged[spaceId] = origin;
    }
  }
  return merged;
}
