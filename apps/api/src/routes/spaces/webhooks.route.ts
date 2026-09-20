import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { eq } from "drizzle-orm";
import { spaces } from "@cohub/db";
import {
  SPACE_HOOK_WEBHOOK_BODY_MAX_BYTES,
  SPACE_HOOK_WEBHOOK_EVENT,
  SPACE_HOOK_WEBHOOK_SECRET_HEADER,
  getSpaceHookName,
  isSpaceHookName,
  type SpaceHookWebhookPayload,
  type SpaceWebhookListItem,
} from "@cohub/protocol";
import { buildSpaceHookDefinitionFingerprint, resolveWebhookHook } from "@cohub/core/hooks";
import { buildSpaceHookExecutePayload, buildSpaceHookTaskId } from "@cohub/infra/space-hooks";
import { db } from "../../db/index.js";
import { authzDenied, requireValidId, useAuth } from "../../lib/middleware.js";
import { hasPermission } from "../../permissions.js";
import { redisCommandClient } from "../../redis.js";
import { loadSpaceHookDefinitionsForApi } from "../../space-hooks.js";
import { spaceFsJsonError } from "../../space-fs-backend.js";
import { enqueueTask } from "../../tasks.js";

const router = new Hono();

const WEBHOOK_RATE_LIMIT_PER_MINUTE = 60;
/** Request headers forwarded to the hook; auth, cookies, and signatures are dropped. */
const FORWARDED_HEADERS = ["content-type", "user-agent", "x-request-id"] as const;

const webhookBodyLimit = bodyLimit({
  maxSize: SPACE_HOOK_WEBHOOK_BODY_MAX_BYTES,
  onError: (c) => c.json({ message: `webhook body exceeds ${SPACE_HOOK_WEBHOOK_BODY_MAX_BYTES} bytes` }, 413),
});

async function consumeWebhookQuota(spaceId: string) {
  const key = `space_webhook:${spaceId}:${Math.floor(Date.now() / 60_000)}`;
  const results = await redisCommandClient.pipeline().incr(key).expire(key, 60).exec();
  const count = Number(results?.[0]?.[1] ?? 0);
  return count <= WEBHOOK_RATE_LIMIT_PER_MINUTE;
}

async function readJsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return null;
  return JSON.parse(text) as unknown;
}

/**
 * Inbound webhook → the same-named `.cohub/hooks/<name>` file.
 *
 * Unauthenticated by design: the space id plus the hook's optional `on.secret`
 * is the credential. The hook file is the single source of truth — no hook,
 * no endpoint.
 */
router.post("/:id/webhooks/:name", webhookBodyLimit, async (c) => {
  const spaceId = c.req.param("id");
  const name = c.req.param("name");
  if (!requireValidId(spaceId) || !isSpaceHookName(name)) return c.json({ message: "webhook not found" }, 404);
  if (!(await consumeWebhookQuota(spaceId))) return c.json({ message: "too many webhook requests" }, 429);

  const [space] = await db.select({ userUuid: spaces.userUuid }).from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "webhook not found" }, 404);

  let definitions: Awaited<ReturnType<typeof loadSpaceHookDefinitionsForApi>>["definitions"];
  try {
    definitions = (await loadSpaceHookDefinitionsForApi(spaceId)).definitions;
  } catch (error) {
    const failure = spaceFsJsonError(error);
    return c.json(failure.body, failure.status as never);
  }

  const secret = c.req.header(SPACE_HOOK_WEBHOOK_SECRET_HEADER) ?? c.req.query("secret") ?? null;
  const resolved = resolveWebhookHook(definitions, { name, secret });
  if (resolved.status === "ambiguous") {
    return c.json({ message: "webhook name is ambiguous; rename one of the hook files" }, 409);
  }
  // Same 404 for missing name and bad secret so the unauthenticated URL is not an oracle.
  if (resolved.status !== "ok") return c.json({ message: "webhook not found" }, 404);

  let body: unknown;
  try {
    body = await readJsonBody(c);
  } catch {
    return c.json({ message: "webhook body must be JSON" }, 400);
  }

  const headers: Record<string, string> = {};
  for (const header of FORWARDED_HEADERS) {
    const value = c.req.header(header);
    if (value) headers[header] = value;
  }
  const payload: SpaceHookWebhookPayload = { name, body, headers };
  const event = {
    id: randomUUID(),
    type: SPACE_HOOK_WEBHOOK_EVENT,
    timestamp: Date.now(),
    spaceId,
    sessionId: null,
    payload,
  };

  // Addressed trigger: skip the broadcast dispatch job and enqueue execution directly.
  // Job id keeps the `space-hook-*` prefix so child run_command tasks share the
  // existing re-entrancy filter (see isReentrantSpaceHookEvent).
  const { taskRunId } = await enqueueTask(buildSpaceHookExecutePayload({
    event,
    eventActorUserId: null,
    ownerUserId: space.userUuid,
    matchedHooks: [{ path: resolved.hook.path, fingerprint: buildSpaceHookDefinitionFingerprint(resolved.hook) }],
  }), {
    jobId: buildSpaceHookTaskId({
      spaceId,
      eventId: event.id,
      eventType: event.type,
    }),
  });

  return c.json({ taskRunId, hook: resolved.hook.path, eventId: event.id }, 202);
});

/** Declared webhook hooks (for Settings). Secrets are never returned — only whether one is set. */
router.get("/:id/webhooks", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "file.view", { spaceId }))) return authzDenied(c);

  try {
    const { definitions } = await loadSpaceHookDefinitionsForApi(spaceId);
    const items: SpaceWebhookListItem[] = definitions
      .filter((hook) => hook.event === SPACE_HOOK_WEBHOOK_EVENT)
      .flatMap((hook) => {
        const name = getSpaceHookName(hook.path);
        return name ? [{ name, path: hook.path, action: hook.action, hasSecret: Boolean(hook.secret) }] : [];
      });
    return c.json({ items });
  } catch (error) {
    const failure = spaceFsJsonError(error);
    return c.json(failure.body, failure.status as never);
  }
});

export default router;
