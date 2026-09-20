export const SPACE_HOOKS_DIR = ".cohub/hooks";
export const SPACE_HOOK_SCHEMA = "cohub.space-hook.v1";
/** User-visible execution task (only created when at least one hook matches). */
export const SPACE_HOOK_TASK_TYPE = "space_hook";
/** Internal system job: load/match definitions; no task_runs row. */
export const SPACE_HOOK_DISPATCH_JOB = "space_hook.dispatch";
/** Positive cache TTL when at least one hook definition was loaded. */
export const SPACE_HOOKS_CACHE_TTL_SEC = 5 * 60;
/**
 * Negative cache TTL for empty definitions.
 * Short so a transient PVC miss cannot hide hooks for long;
 * `space.workspace.ready` and `.cohub/hooks/**` changes also invalidate.
 */
export const SPACE_HOOKS_EMPTY_CACHE_TTL_SEC = 30;

export const SPACE_HOOKABLE_EVENTS = [
  "space.fs.changed",
  "space.workspace.ready",
  "session.turn.finalized",
  "checkpoint.created",
  "app.version.published",
  "task.updated",
  "webhook",
] as const;

export type SpaceHookableEvent = (typeof SPACE_HOOKABLE_EVENTS)[number];

/**
 * Inbound HTTP trigger. A hook file `.cohub/hooks/<name>.yml` declaring
 * `on.event: webhook` is addressed as `POST /api/spaces/:id/webhooks/<name>`.
 * Unlike broadcast events, a webhook targets exactly that one hook file.
 */
export const SPACE_HOOK_WEBHOOK_EVENT = "webhook" satisfies SpaceHookableEvent;
export const SPACE_HOOK_WEBHOOK_BODY_MAX_BYTES = 64 * 1024;
export const SPACE_HOOK_WEBHOOK_SECRET_HEADER = "x-cohub-webhook-secret";

const SPACE_HOOK_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Hook file stem: `.cohub/hooks/<name>.yml` → `<name>`. */
export const isSpaceHookName = (value: string) => SPACE_HOOK_NAME_RE.test(value);

export function getSpaceHookName(path: string): string | null {
  const file = path.split("/").at(-1) ?? "";
  const name = file.replace(/\.(ya?ml|json)$/i, "");
  return name && name !== file && isSpaceHookName(name) ? name : null;
}

export type SpaceHookWebhookPayload = {
  name: string;
  body: unknown;
  /** Lowercased request headers, allowlisted by the receiver. */
  headers: Record<string, string>;
};

/** `GET /api/spaces/:id/webhooks` item. The secret itself is never exposed. */
export type SpaceWebhookListItem = {
  name: string;
  path: string;
  action: "run" | "prompt" | "uses";
  hasSecret: boolean;
};

export type SpaceWebhookTriggerResponse = {
  taskRunId: string;
  hook: string;
  eventId: string;
};

/** Lightweight event envelope carried by space_hook tasks. */
export type SpaceHookEventEnvelope = {
  id: string;
  type: string;
  timestamp: number;
  spaceId: string;
  sessionId?: string | null;
  payload: Record<string, unknown>;
};

export const isSpaceHookableEvent = (type: string): type is SpaceHookableEvent =>
  (SPACE_HOOKABLE_EVENTS as readonly string[]).includes(type);

export const getSpaceHooksRedisKey = (spaceId: string) => `cohub:space-hooks:v1:${spaceId}`;

export function isSpaceHooksConfigPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
  return normalized === SPACE_HOOKS_DIR || normalized.startsWith(`${SPACE_HOOKS_DIR}/`);
}

/** True when the event must invalidate the definition cache and bypass the empty-cache gate. */
export function shouldRefreshSpaceHooksCache(input: {
  type: string;
  paths?: readonly string[];
}): boolean {
  if (input.type === "space.workspace.ready") return true;
  if (input.type !== "space.fs.changed") return false;
  return (input.paths ?? []).some(isSpaceHooksConfigPath);
}
