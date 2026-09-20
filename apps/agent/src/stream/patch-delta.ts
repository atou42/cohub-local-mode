import type { ContentBlock } from "@cohub/protocol/core";
import type { RealtimePatchOperation, SessionStreamEvent } from "@cohub/protocol/realtime";
import { getSessionTurnPatchStreamKey } from "@cohub/protocol/realtime";

const getStreamIndex = (block: ContentBlock, fallback: number) => {
  const value = block._meta?.streamIndex;
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

const blockPatchPath = (block: ContentBlock, fallback: number) =>
  `/message/content/blocks/${getStreamIndex(block, fallback)}`;

type AppendPatchCursor = { p: string; lastSeenAt: number };
type StreamBlockSnapshot = { lastSeenAt: number; block: ContentBlock };

const PATCH_CURSOR_MAX_AGE_MS = 10 * 60 * 1000;
const appendPatchCursors = new Map<string, AppendPatchCursor>();
const streamBlockSnapshots = new Map<string, StreamBlockSnapshot>();

const patchCursorKey = (event: SessionStreamEvent) =>
  `${event.sessionId}:${getSessionTurnPatchStreamKey(event) ?? "unknown"}`;

const blockSnapshotIdentity = (block: ContentBlock) => {
  if (block.type === "tool_use") return `tool_use:${block.id}`;
  if (block.type === "tool_result") return `tool_result:${block.tool_use_id}`;
  return block.type;
};

const streamBlockSnapshotKey = (event: SessionStreamEvent, streamIndex: number, block: ContentBlock) =>
  `${patchCursorKey(event)}:${streamIndex}:${blockSnapshotIdentity(block)}`;

const pruneExpired = (now: number) => {
  for (const [key, cursor] of appendPatchCursors) {
    if (now - cursor.lastSeenAt > PATCH_CURSOR_MAX_AGE_MS) appendPatchCursors.delete(key);
  }
  for (const [key, snap] of streamBlockSnapshots) {
    if (now - snap.lastSeenAt > PATCH_CURSOR_MAX_AGE_MS) streamBlockSnapshots.delete(key);
  }
};

const clearStreamBlockSnapshotsForEvent = (event: SessionStreamEvent) => {
  const prefix = `${patchCursorKey(event)}:`;
  for (const key of [...streamBlockSnapshots.keys()]) {
    if (key.startsWith(prefix)) streamBlockSnapshots.delete(key);
  }
};

const encodeJsonPointerSegment = (segment: string) => segment.replace(/~/g, "~0").replace(/\//g, "~1");
const joinPointerPath = (basePath: string, segments: string[]) =>
  segments.length === 0 ? basePath : `${basePath}/${segments.map(encodeJsonPointerSegment).join("/")}`;

const isPlainObject = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const blockIdentityCompatible = (prev: ContentBlock, next: ContentBlock) => {
  if (prev.type !== next.type) return false;
  if (prev.type === "tool_use" && next.type === "tool_use") return prev.id === next.id && prev.name === next.name;
  if (prev.type === "tool_result" && next.type === "tool_result") return prev.tool_use_id === next.tool_use_id;
  return true;
};

const MAX_BLOCK_DIFF_DEPTH = 48;

function diffUnknownToOps(
  blockBasePath: string,
  prev: unknown,
  next: unknown,
  segments: string[],
  out: RealtimePatchOperation[],
  depth: number,
): "ok" | "fallback" {
  if (depth > MAX_BLOCK_DIFF_DEPTH) return "fallback";
  if (prev === undefined && next === undefined) return "ok";
  if (prev === undefined) {
    out.push({ o: "replace", p: joinPointerPath(blockBasePath, segments), v: next });
    return "ok";
  }
  if (next === undefined) return "fallback";
  if (typeof prev === "string" && typeof next === "string") {
    if (next.startsWith(prev) && next.length > prev.length) {
      out.push({ o: "append", p: joinPointerPath(blockBasePath, segments), v: next.slice(prev.length) });
      return "ok";
    }
    if (prev !== next) out.push({ o: "replace", p: joinPointerPath(blockBasePath, segments), v: next });
    return "ok";
  }
  if (Array.isArray(prev) || Array.isArray(next)) {
    if (JSON.stringify(prev) !== JSON.stringify(next)) out.push({ o: "replace", p: joinPointerPath(blockBasePath, segments), v: next });
    return "ok";
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    for (const k of [...keys].sort()) {
      const hasP = Object.hasOwn(prev, k);
      const hasN = Object.hasOwn(next, k);
      if (hasP && !hasN) return "fallback";
      const child = diffUnknownToOps(blockBasePath, hasP ? prev[k] : undefined, next[k], [...segments, k], out, depth + 1);
      if (child === "fallback") return "fallback";
    }
    return "ok";
  }
  if (prev !== next) out.push({ o: "replace", p: joinPointerPath(blockBasePath, segments), v: next });
  return "ok";
}

const diffContentBlocksToOps = (blockBasePath: string, prev: ContentBlock | undefined, next: ContentBlock): RealtimePatchOperation[] | "fallback" => {
  if (!prev || !blockIdentityCompatible(prev, next)) return "fallback";
  const p = prev as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  const keys = new Set([...Object.keys(p), ...Object.keys(n)]);
  const out: RealtimePatchOperation[] = [];
  for (const k of [...keys].sort()) {
    if (k === "type") continue;
    const hasP = Object.hasOwn(p, k);
    const hasN = Object.hasOwn(n, k);
    if (hasP && !hasN) return "fallback";
    const result = diffUnknownToOps(blockBasePath, hasP ? p[k] : undefined, n[k], [k], out, 0);
    if (result === "fallback") return "fallback";
  }
  return out;
};

const resolveFullBlockFromSnapshot = (snapshotContent: ContentBlock[] | undefined, streamIndex: number, deltaBlock: ContentBlock): ContentBlock => {
  if (!snapshotContent?.length) return deltaBlock;
  return snapshotContent.find((b) => getStreamIndex(b, -1) === streamIndex && blockIdentityCompatible(b, deltaBlock)) ?? deltaBlock;
};

const compactAppendPatchOps = (event: SessionStreamEvent, ops: RealtimePatchOperation[]) => {
  const now = Date.now();
  pruneExpired(now);
  const key = patchCursorKey(event);
  let cursor = event.baseSeq === 0 ? null : appendPatchCursors.get(key) ?? null;
  const compacted: RealtimePatchOperation[] = [];

  for (const op of ops) {
    if (op.o === "append" && typeof op.p === "string") {
      compacted.push(cursor?.p === op.p ? { v: op.v } : op);
      cursor = { p: op.p, lastSeenAt: now };
      continue;
    }
    compacted.push(op);
  }

  if (cursor) appendPatchCursors.set(key, cursor);
  else appendPatchCursors.delete(key);
  return compacted;
};

export const getAppendPathForStreamEvent = (event: SessionStreamEvent) => appendPatchCursors.get(patchCursorKey(event))?.p ?? null;

export const buildPatchOpsForContentDelta = (event: SessionStreamEvent): RealtimePatchOperation[] => {
  const ops: RealtimePatchOperation[] = [];
  const now = Date.now();
  if (event.baseSeq === 0) {
    clearStreamBlockSnapshotsForEvent(event);
    ops.push({ o: "replace", p: "/message/status", v: "streaming" }, { o: "replace", p: "/message/end_turn", v: false });
    const metadata: Record<string, unknown> = { is_complete: false };
    if (event.turnId) metadata.turnId = event.turnId;
    if (event.anchorUserMessageId) metadata.anchorUserMessageId = event.anchorUserMessageId;
    ops.push({ o: "merge", p: "/message/metadata", v: metadata });
  }

  if (event.replaceContent) {
    const prefix = `${patchCursorKey(event)}:`;
    const retained = new Set((event.snapshotContent ?? event.content).map((block, index) => getStreamIndex(block, index)));
    const removed = new Set<number>();
    for (const [key, snapshot] of streamBlockSnapshots) {
      if (!key.startsWith(prefix)) continue;
      const index = getStreamIndex(snapshot.block, Number(key.slice(prefix.length).split(":")[0]));
      if (!retained.has(index)) { removed.add(index); streamBlockSnapshots.delete(key); }
    }
    for (const index of [...removed].sort((a, b) => b - a)) ops.push({ o: "remove", p: `/message/content/blocks/${index}` });
    appendPatchCursors.delete(patchCursorKey(event));
  }

  event.content.forEach((deltaBlock, index) => {
    const path = blockPatchPath(deltaBlock, index);
    const streamIndex = getStreamIndex(deltaBlock, index);
    const snapKey = streamBlockSnapshotKey(event, streamIndex, deltaBlock);
    const nextFull = resolveFullBlockFromSnapshot(event.snapshotContent, streamIndex, deltaBlock);
    const prevFull = streamBlockSnapshots.get(snapKey)?.block;
    const diffResult = diffContentBlocksToOps(path, prevFull, nextFull);
    if (diffResult !== "fallback" && diffResult.length > 0) ops.push(...diffResult);
    else if (diffResult === "fallback") ops.push({ o: "replace", p: path, v: nextFull });
    streamBlockSnapshots.set(snapKey, { lastSeenAt: now, block: structuredClone(nextFull) });
  });

  return compactAppendPatchOps(event, ops);
};
