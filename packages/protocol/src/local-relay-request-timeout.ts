type RelayRequestTiming = {
  method: string;
  path: string;
  bodyParts?: readonly unknown[];
};

export function localRelayRequestTimeoutMs(request: RelayRequestTiming, defaultTimeoutMs: number) {
  const path = request.path.split("?", 1)[0]!;
  if (request.method === "POST" && /^\/api\/spaces\/[^/]+\/fs\/uploads\/[^/]+\/complete\/?$/.test(path)) {
    // sandbox-bash-queue waits up to one hour; allow its final HTTP result to arrive.
    return Math.max(defaultTimeoutMs, 61 * 60_000);
  }
  const fileDownload = request.method === "GET" && /^\/api\/spaces\/[^/]+\/fs\/download\/?$/.test(path);
  return request.bodyParts?.length || fileDownload ? Math.max(defaultTimeoutMs, 10 * 60_000) : defaultTimeoutMs;
}
