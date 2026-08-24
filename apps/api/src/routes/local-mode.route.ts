import { resolveAccessToken } from "@neta-art/cohub-cli/auth";
import { Hono } from "hono";
import { config } from "../config.js";

const router = new Hono();

export function hasTrustedLocalModeEntry(request: Request) {
  const hostname = new URL(request.url).hostname.toLowerCase();
  if (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1"
  ) {
    return true;
  }
  if (process.env.NODE_ENV !== "production") return true;
  const tailscaleHostname = process.env.COHUB_LOCAL_TAILSCALE_HOST
    ?.trim()
    .toLowerCase();
  const ownerEmail = process.env.COHUB_LOCAL_OWNER_EMAIL
    ?.trim()
    .toLowerCase();
  const tailscaleUser = request.headers
    .get("tailscale-user-login")
    ?.trim()
    .toLowerCase();
  if (
    tailscaleHostname &&
    ownerEmail &&
    hostname === tailscaleHostname &&
    tailscaleUser === ownerEmail
  ) {
    return true;
  }
  return Boolean(request.headers.get("cf-access-jwt-assertion")?.trim());
}

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

export default router;
