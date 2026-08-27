import { isUuid, parseAgentHarness } from "@cohub/protocol";
import { createLogger } from "@cohub/infra/logging";
import { Hono } from "hono";
import { config } from "../config.js";
import { loadHarnessCapabilities } from "../local-mode/harness-capabilities.js";
import { authzDenied, getOptionalAuth } from "../lib/middleware.js";
import { hasPermission } from "../permissions.js";

const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

router.get("/", async (c) => {
  if (config.nodeOrigin !== "local") {
    return c.json({ message: "harness capabilities are only available on a local node" }, 404);
  }
  const spaceId = c.req.query("spaceId")?.trim() ?? "";
  const harness = parseAgentHarness(c.req.query("harness"));
  if (!spaceId) return c.json({ message: "spaceId is required" }, 400);
  if (!isUuid(spaceId)) return c.json({ message: "spaceId must be a valid UUID" }, 400);
  if (!harness) {
    return c.json({ message: "harness must be one of: pi, codex, grok_build" }, 400);
  }
  const user = getOptionalAuth(c);
  if (!(await hasPermission(user, "space.view", { spaceId }))) return authzDenied(c);

  try {
    return c.json(await loadHarnessCapabilities({
      spaceId,
      harness,
      forceReload: c.req.query("forceReload") === "true",
    }));
  } catch (error) {
    logger.error("[harness-capabilities] discovery failed", {
      spaceId,
      harness,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({
      message: error instanceof Error ? error.message : "failed to load harness capabilities",
    }, 502);
  }
});

export default router;
