import { Hono } from "hono";
import { config } from "../config.js";
import { systemHarnessReadinessService } from "../local-mode/harness-readiness.js";
import { useAuth } from "../lib/middleware.js";

const router = new Hono();

router.get("/", async (c) => {
  if (config.nodeOrigin !== "local") {
    return c.json({ message: "harness readiness is only available on a local node" }, 404);
  }
  const user = useAuth(c);
  if (user instanceof Response) return user;
  return c.json(await systemHarnessReadinessService.list({
    force: c.req.query("force") === "true",
  }));
});

export default router;
