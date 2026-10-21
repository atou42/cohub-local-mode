import { mimeTypeForPath, type SpaceFsChange } from "@cohub/protocol/fs";
import { shouldUseFsCdnCache } from "./policy.js";
import type { FsCdnWarmFileJob, FsCdnWarmReason } from "./types.js";

export type FsCdnFileMeta = {
  spaceId: string;
  path: string;
  name: string;
  size: number;
  mimeType: string | null;
  mtimeMs: number;
};

export function createFsCdnWarmJobsForChanges(input: {
  spaceId: string;
  changes: SpaceFsChange[];
  reason?: FsCdnWarmReason;
  now?: number;
}) {
  const requestedAt = input.now ?? Date.now();
  const reason = input.reason ?? "fs_changed";
  const jobs: FsCdnWarmFileJob[] = [];

  for (const change of input.changes) {
    if ((change.kind !== "create" && change.kind !== "modify") || change.nodeType !== "file") continue;
    if (!change.path || change.size == null || change.mtimeMs == null) continue;
    const mimeType = mimeTypeForPath(change.path);
    if (!shouldUseFsCdnCache({ path: change.path, mimeType, size: change.size })) continue;
    jobs.push({
      spaceId: input.spaceId,
      path: change.path,
      size: change.size,
      mtimeMs: change.mtimeMs,
      mimeType,
      requestedAt,
      reason,
    });
  }

  return jobs;
}
