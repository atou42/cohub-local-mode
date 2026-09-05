import { CohubClient, CohubHttpClient, readRequestSourceFromEnv } from "@neta-art/cohub";
import { clearAuthSession, resolveAccessToken } from "./auth.js";

export function shouldClearHostAuthOnUnauthorized(
  environment: Record<string, string | undefined>,
) {
  return !environment.COHUB_EXECUTION_TOKEN?.trim();
}

const clientOptions = () => ({
  baseUrl: process.env.COHUB_API_URL?.trim() || undefined,
  getAccessToken: resolveAccessToken,
  onUnauthorized: async () => {
    if (!shouldClearHostAuthOnUnauthorized(process.env)) return;
    await clearAuthSession();
  },
  websocket: {
    url: process.env.COHUB_WS_URL?.trim() || undefined,
    getAccessToken: resolveAccessToken,
  },
  requestSource: () =>
    readRequestSourceFromEnv(process.env as Record<string, string | undefined>, { via: "cli" }) ?? {
      via: "cli" as const,
    },
});

export function createClient(): CohubHttpClient {
  return new CohubHttpClient(clientOptions());
}

export function createClientWithAccessToken(token: string): CohubHttpClient {
  return new CohubHttpClient({ ...clientOptions(), getAccessToken: () => token });
}

export function createRealtimeClient(): CohubClient {
  return new CohubClient(clientOptions());
}
