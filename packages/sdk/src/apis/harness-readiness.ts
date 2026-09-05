import type { HarnessReadinessResponse } from "@cohub/protocol";
import type { HttpTransport } from "../transport.js";

export class HarnessReadinessApi {
  constructor(private readonly transport: HttpTransport) {}

  async list(options: { force?: boolean } = {}) {
    return this.transport.request<HarnessReadinessResponse>(
      `/api/harness-readiness${options.force ? "?force=true" : ""}`,
    );
  }
}
