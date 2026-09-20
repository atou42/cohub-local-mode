import { timingSafeEqual } from "node:crypto";
import { SPACE_HOOK_WEBHOOK_EVENT, getSpaceHookName } from "@cohub/protocol";
import type { SpaceHookDefinition } from "./types.js";

export type ResolveWebhookHookResult =
  | { status: "ok"; hook: SpaceHookDefinition }
  | { status: "not_found" }
  | { status: "unauthorized" }
  | { status: "ambiguous" };

function secretsMatch(expected: string, provided: string | null | undefined) {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Resolve the hook addressed by `POST /api/spaces/:id/webhooks/:name`.
 * Only a same-named file declaring `on.event: webhook` qualifies; a declared
 * `on.secret` must match the caller-provided one.
 *
 * `unauthorized` is for the receiver to map to the same 404 as `not_found`
 * so an unauthenticated endpoint does not leak whether the name exists.
 */
export function resolveWebhookHook(
  definitions: readonly SpaceHookDefinition[],
  input: { name: string; secret?: string | null },
): ResolveWebhookHookResult {
  const matches = definitions.filter(
    (definition) => definition.event === SPACE_HOOK_WEBHOOK_EVENT && getSpaceHookName(definition.path) === input.name,
  );
  if (matches.length === 0) return { status: "not_found" };
  if (matches.length > 1) return { status: "ambiguous" };
  const hook = matches[0];
  if (!hook) return { status: "not_found" };
  if (hook.secret && !secretsMatch(hook.secret, input.secret)) return { status: "unauthorized" };
  return { status: "ok", hook };
}
