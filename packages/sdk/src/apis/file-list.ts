import type { Fetch, HttpTransport } from "../transport.js";
import type { SpaceFsListOptions, SpaceFsTreePage, SpaceFsTreeResponse } from "../types.js";

export type FileListOptions = SpaceFsListOptions & { fetch?: Fetch; signal?: AbortSignal };

export async function listDirectory(
  transport: HttpTransport,
  endpoint: string,
  path: string,
  options?: Fetch | FileListOptions,
): Promise<SpaceFsTreeResponse | SpaceFsTreePage> {
  const pageOptions = typeof options === "object" ? options : undefined;
  const fetch = typeof options === "function" ? options : pageOptions?.fetch;
  const entries = new Map<string, SpaceFsTreeResponse["entries"][number]>();
  const seen = new Set<string>();
  let cursor = pageOptions?.cursor;
  let responsePath = path;
  do {
    const params = new URLSearchParams({ pagination: "true" });
    if (path) params.set("path", path);
    if (pageOptions?.limit !== undefined) params.set("limit", String(pageOptions.limit));
    if (cursor) params.set("cursor", cursor);
    const page = await transport.request<SpaceFsTreeResponse & Partial<SpaceFsTreePage>>(
      `${endpoint}?${params}`, { fetch, signal: pageOptions?.signal },
    );
    const nextCursor = page.nextCursor ?? null;
    if (pageOptions) return { ...page, nextCursor, truncated: page.truncated ?? true };
    responsePath = page.path;
    for (const entry of page.entries) entries.set(entry.path, entry);
    if (nextCursor && seen.has(nextCursor)) throw new Error("Server returned a repeated directory cursor.");
    if (nextCursor) seen.add(nextCursor);
    cursor = nextCursor ?? undefined;
  } while (cursor);
  const rank = { dir: 0, symlink: 1, file: 2 };
  return {
    path: responsePath,
    entries: [...entries.values()].sort((a, b) => rank[a.type] - rank[b.type] || a.name.localeCompare(b.name)),
  };
}
