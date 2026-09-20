import type { ContentBlock } from "@cohub/protocol/core";
import type { RuntimeContext } from "@cohub/protocol";

const IMAGE_CONCURRENCY = 4;
type Image = { data: Buffer; mimeType: string };

/** Bound downloads across the entire history, deduplicate URLs, and preserve source order. */
export async function hydrateContextImages(context: RuntimeContext, read: (url: string) => Promise<Image | null>): Promise<RuntimeContext> {
  const urls = new Set<string>();
  const collect = (content: ContentBlock[]) => {
    for (const block of content) {
      if (block.type === "image" && block.source.type === "url") urls.add(block.source.url);
      else if (block.type === "tool_result" && Array.isArray(block.content)) collect(block.content);
    }
  };
  for (const message of context.messages) collect(message.content);
  const pending = [...urls];
  const cache = new Map<string, Promise<Image | null>>();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, pending.length) }, async () => {
    while (cursor < pending.length) {
      const url = pending[cursor++];
      if (url === undefined) continue;
      const task = Promise.resolve().then(() => read(url)).catch(() => null);
      cache.set(url, task);
      await task;
    }
  }));
  const blocks = (content: ContentBlock[]): Promise<ContentBlock[]> => Promise.all(content.map(async (block): Promise<ContentBlock> => {
    if (block.type === "image" && block.source.type === "url") {
      const image = await cache.get(block.source.url);
      // Unavailable URLs keep their original block; the projector drops what has no native form.
      return image ? { ...block, source: { type: "base64", data: image.data.toString("base64"), media_type: image.mimeType } } : block;
    }
    if (block.type === "tool_result" && Array.isArray(block.content)) return { ...block, content: await blocks(block.content) };
    return block;
  }));
  return { ...context, messages: await Promise.all(context.messages.map(async (message) => ({ ...message, content: await blocks(message.content) }))) };
}
