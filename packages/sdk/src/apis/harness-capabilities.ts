import type { HttpTransport, Fetch } from "../transport.js";
import type { AgentHarness, HarnessCapabilityCatalog } from "../types.js";

export class HarnessCapabilitiesApi {
  constructor(private readonly transport: HttpTransport) {}

  async list(
    input: { spaceId: string; harness: AgentHarness; forceReload?: boolean },
    customFetch?: Fetch,
  ) {
    const params = new URLSearchParams({
      spaceId: input.spaceId,
      harness: input.harness,
    });
    if (input.forceReload) params.set("forceReload", "true");
    return this.transport.request<HarnessCapabilityCatalog>(
      `/api/harness-capabilities?${params.toString()}`,
      { fetch: customFetch },
    );
  }
}
