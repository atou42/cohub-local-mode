export function hasLoopbackLocalModeEntry(request: Request) {
  const hostname = new URL(request.url).hostname.toLowerCase();
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

export function hasTrustedLocalModeEntry(request: Request) {
  const hostname = new URL(request.url).hostname.toLowerCase();
  if (hasLoopbackLocalModeEntry(request)) return true;
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
