import { resolveAccessToken } from "@neta-art/cohub-cli/auth";
import { Hono } from "hono";
import { config } from "../config.js";
import { useAuth, authzDenied } from "../lib/middleware.js";
import { hasPermission } from "../permissions.js";
import { getSpaceSessionById } from "../space-sessions.js";
import { getSpaceSandboxBySpaceId } from "../space-sandboxes.js";
import { persistCompletedTurnRelayArtifacts } from "../session-turns.js";
import { dispatchTurnUpdated } from "../session-output.js";
import {
  RelayArtifactProjectionError,
  type RelayArtifactReplacement,
} from "../local-mode/relay-artifacts.js";
import {
  hasLoopbackLocalModeEntry,
  hasTrustedLocalModeEntry,
} from "../local-mode/access.js";

const router = new Hono();

router.get("/route-health", (c) => {
  if (config.nodeOrigin !== "local") {
    return c.json({ message: "not found" }, 404);
  }
  c.header("Cache-Control", "no-store");
  c.header("X-Cohub-Local-Node", "1");
  return c.json({ status: "ready", origin: "local" });
});

router.get("/auth", async (c) => {
  if (config.nodeOrigin !== "local")
    return c.json({ message: "not found" }, 404);
  if (!hasTrustedLocalModeEntry(c.req.raw)) {
    return c.json(
      { message: "Cloudflare Access authentication is required" },
      403,
    );
  }

  const forceRefresh = c.req.query("refresh") === "1";
  const accessToken = await resolveAccessToken({ forceRefresh }).catch(
    (error) => {
      if (error instanceof Error && error.name === "AuthRequiredError")
        return null;
      throw error;
    },
  );
  if (!accessToken) {
    return c.json(
      {
        message:
          "Cloud account is not connected. Run cohub auth login on the host.",
      },
      401,
    );
  }

  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  return c.json({ accessToken });
});

router.post("/relay-artifacts", async (c) => {
  if (config.nodeOrigin !== "local") {
    return c.json({ message: "not found" }, 404);
  }
  if (!hasLoopbackLocalModeEntry(c.req.raw)) {
    return c.json({ message: "loopback access is required" }, 403);
  }
  const user = useAuth(c);
  if (user instanceof Response) return user;

  const body = await c.req.json<unknown>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ message: "invalid json body" }, 400);
  }
  const sessionId = Reflect.get(body, "sessionId");
  const turnId = Reflect.get(body, "turnId");
  const rawReplacements = Reflect.get(body, "replacements");
  if (
    typeof sessionId !== "string" ||
    typeof turnId !== "string" ||
    !Array.isArray(rawReplacements) ||
    rawReplacements.some(
      (replacement) =>
        !replacement ||
        typeof replacement !== "object" ||
        typeof Reflect.get(replacement, "from") !== "string" ||
        typeof Reflect.get(replacement, "to") !== "string",
    )
  ) {
    return c.json({ message: "invalid relay artifact projection" }, 400);
  }
  const replacements = rawReplacements.map((replacement) => ({
    from: Reflect.get(replacement, "from"),
    to: Reflect.get(replacement, "to"),
  })) as RelayArtifactReplacement[];

  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (
    !(await hasPermission(user, "session.prompt.fullaccess", {
      spaceId: session.spaceId,
      sessionId,
    }))
  ) {
    return authzDenied(c);
  }
  const sandbox = await getSpaceSandboxBySpaceId(session.spaceId);
  if (sandbox?.provider !== "local") {
    return c.json({ message: "relay artifact projection requires a local Space" }, 409);
  }

  try {
    const turn = await persistCompletedTurnRelayArtifacts({
      sessionId,
      turnId,
      replacements,
    });
    await dispatchTurnUpdated({
      spaceId: session.spaceId,
      sessionId,
      turn,
    });
    return c.json({ ok: true, turn });
  } catch (error) {
    if (error instanceof RelayArtifactProjectionError) {
      return c.json(
        { message: error.message, code: error.code },
        error.code === "artifact_target_missing" ? 409 : 400,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message === "turn not found") return c.json({ message }, 404);
    if (message === "turn is not completed" || message.includes("changed before")) {
      return c.json({ message }, 409);
    }
    throw error;
  }
});

export default router;
