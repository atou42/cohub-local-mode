import { createHash } from "node:crypto";
import { SPACE_HOOK_WEBHOOK_EVENT, getSpaceHookName, type SpaceHookEventEnvelope } from "@cohub/protocol";
import { picomatch } from "./picomatch-shim.js";
import type { SpaceHookDefinition } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

const matcherCache = new Map<string, (path: string) => boolean>();

function getMatcher(pattern: string): (path: string) => boolean {
  const normalized = normalizePath(pattern);
  let matcher = matcherCache.get(normalized);
  if (!matcher) {
    matcher = picomatch(normalized, { dot: true });
    matcherCache.set(normalized, matcher);
  }
  return matcher;
}

function matchGlob(pattern: string, value: string): boolean {
  return getMatcher(pattern)(normalizePath(value));
}

function matchesAny(patterns: string[] | undefined, values: string[]): boolean {
  if (!patterns || patterns.length === 0) return true;
  return values.some((value) => patterns.some((pattern) => matchGlob(pattern, value)));
}

function isIgnored(patterns: string[] | undefined, values: string[]): boolean {
  if (!patterns || patterns.length === 0) return false;
  return values.every((value) => patterns.some((pattern) => matchGlob(pattern, value)));
}

function collectFsPaths(payload: Record<string, unknown>) {
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const paths: string[] = [];
  const kinds: string[] = [];
  for (const change of changes) {
    if (!isRecord(change)) continue;
    if (typeof change.path === "string" && change.path.trim()) paths.push(normalizePath(change.path));
    if (typeof change.oldPath === "string" && change.oldPath.trim()) paths.push(normalizePath(change.oldPath));
    if (typeof change.kind === "string" && change.kind.trim()) kinds.push(change.kind.trim());
  }
  return {
    paths: Array.from(new Set(paths)),
    kinds: Array.from(new Set(kinds)),
    resync: payload.resync === true,
  };
}

function resolveTurnSource(payload: Record<string, unknown>): string | null {
  const turn = isRecord(payload.turn) ? payload.turn : null;
  const meta = isRecord(turn?.meta) ? turn.meta : null;
  return typeof meta?.source === "string" && meta.source.trim() ? meta.source.trim() : null;
}

function normalizeLabelRef(value: string): string {
  return value.trim().toLowerCase();
}

function resolveSessionLabelRefs(payload: Record<string, unknown>): Set<string> | null {
  if (!Array.isArray(payload.sessionLabelRefs)) return null;
  return new Set(
    payload.sessionLabelRefs
      .filter((value): value is string => typeof value === "string")
      .map(normalizeLabelRef),
  );
}

function matchesSessionLabels(
  hook: SpaceHookDefinition,
  event: SpaceHookEventEnvelope,
): { matched: boolean; reason?: string } {
  if (!hook.labels) return { matched: true };
  const labels = resolveSessionLabelRefs(event.payload);
  if (!labels) return { matched: false, reason: "label_filter" };
  const any = hook.labels.any?.map(normalizeLabelRef);
  const all = hook.labels.all?.map(normalizeLabelRef);
  const none = hook.labels.none?.map(normalizeLabelRef);
  if (any && !any.some((label) => labels.has(label))) return { matched: false, reason: "label_filter" };
  if (all && !all.every((label) => labels.has(label))) return { matched: false, reason: "label_filter" };
  if (none?.some((label) => labels.has(label))) return { matched: false, reason: "label_filter" };
  return { matched: true };
}

function matchSessionTurnFinalized(
  hook: SpaceHookDefinition,
  event: SpaceHookEventEnvelope,
): { matched: boolean; reason?: string } {
  const sessionId = typeof event.sessionId === "string" ? event.sessionId.trim() : "";
  if (!sessionId) {
    return { matched: false, reason: "no_session" };
  }
  if (hook.ignoreSessionIds?.includes(sessionId)) {
    return { matched: false, reason: "session_ignored" };
  }
  if (hook.sessionIds && hook.sessionIds.length > 0 && !hook.sessionIds.includes(sessionId)) {
    return { matched: false, reason: "session_filter" };
  }

  if (hook.sources && hook.sources.length > 0) {
    const source = resolveTurnSource(event.payload);
    if (!source || !hook.sources.includes(source)) {
      return { matched: false, reason: "source_filter" };
    }
  }

  return matchesSessionLabels(hook, event);
}

function matchFsChanged(
  hook: SpaceHookDefinition,
  event: SpaceHookEventEnvelope,
): { matched: boolean; reason?: string } {
  const { paths, kinds, resync } = collectFsPaths(event.payload);
  if (resync && paths.length === 0) {
    // Resync with no concrete paths is a "refresh your tree" signal, not a change.
    return { matched: false, reason: "fs_resync_no_paths" };
  }
  if (paths.length === 0) {
    return { matched: false, reason: "no_paths" };
  }

  // Always ignore .cohub/** to prevent hook self-trigger loops.
  const activePaths = paths.filter((path) =>
    !path.startsWith(".cohub/") && !isIgnored(hook.ignore, [path]));
  if (activePaths.length === 0) {
    return { matched: false, reason: "ignored" };
  }
  if (!matchesAny(hook.paths, activePaths)) {
    return { matched: false, reason: "path_filter" };
  }
  if (hook.kinds && hook.kinds.length > 0) {
    if (kinds.length === 0) return { matched: false, reason: "kind_filter" };
    if (!kinds.some((kind) => hook.kinds?.includes(kind as "create" | "modify" | "delete" | "rename"))) {
      return { matched: false, reason: "kind_filter" };
    }
  }
  return { matched: true };
}

export function buildSpaceHookDefinitionFingerprint(definition: SpaceHookDefinition): string {
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
}

export function spaceHookMatchesEvent(
  hook: SpaceHookDefinition,
  event: SpaceHookEventEnvelope,
): { matched: boolean; reason?: string } {
  if (hook.event !== event.type) {
    return { matched: false, reason: "event_mismatch" };
  }

  if (event.type === "space.fs.changed") {
    return matchFsChanged(hook, event);
  }
  if (event.type === "session.turn.finalized") {
    return matchSessionTurnFinalized(hook, event);
  }
  if (event.type === SPACE_HOOK_WEBHOOK_EVENT) {
    // Webhooks are addressed, not broadcast: only the same-named hook file runs.
    const name = typeof event.payload.name === "string" ? event.payload.name : null;
    return name && getSpaceHookName(hook.path) === name
      ? { matched: true }
      : { matched: false, reason: "webhook_name" };
  }

  return { matched: true };
}

/** Partition definitions into matched vs skipped for a single event. */
export function partitionSpaceHooksForEvent(
  definitions: SpaceHookDefinition[],
  event: SpaceHookEventEnvelope,
): {
  matched: SpaceHookDefinition[];
  skipped: Array<{ path: string; action: SpaceHookDefinition["action"]; reason: string }>;
} {
  const matched: SpaceHookDefinition[] = [];
  const skipped: Array<{ path: string; action: SpaceHookDefinition["action"]; reason: string }> = [];
  for (const definition of definitions) {
    const match = spaceHookMatchesEvent(definition, event);
    if (match.matched) {
      matched.push(definition);
      continue;
    }
    skipped.push({
      path: definition.path,
      action: definition.action,
      reason: match.reason ?? "not_matched",
    });
  }
  return { matched, skipped };
}
