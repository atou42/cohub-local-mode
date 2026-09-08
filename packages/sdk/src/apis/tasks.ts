import { getRealtimeSpaceRoom } from "@cohub/protocol/realtime/types";
import { ensureRealtimeConnected } from "../realtime.js";
import type { WebsocketClient, WebsocketEventPayload } from "../websocket.js";
import type { HttpTransport } from "../transport.js";
import type { TaskRunDetailResponse, TaskRunRecord } from "../types.js";

const isTerminal = (status: TaskRunRecord["status"]) =>
  status === "completed" || status === "failed";

const MAX_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MIN_POLL_INTERVAL_MS = 100;

function validateWaitNumber(name: string, value: number, max?: number) {
  if (!Number.isFinite(value) || value <= 0 || (max !== undefined && value > max)) {
    const suffix = max === undefined ? "greater than 0" : `greater than 0 and at most ${max}ms`;
    throw new RangeError(`${name} must be ${suffix}.`);
  }
}

export type TaskWaitOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
};

export class TasksApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly websocketClient: WebsocketClient | null = null,
  ) {}

  get(taskRunId: string, options?: { signal?: AbortSignal }) {
    return this.transport.request<TaskRunDetailResponse>(`/api/tasks/${taskRunId}`, {
      signal: options?.signal,
    });
  }

  async wait(taskRunId: string, options: TaskWaitOptions = {}) {
    if (options.signal?.aborted) throw new DOMException("The task wait was aborted.", "AbortError");
    const timeoutMs = options.timeoutMs ?? 120_000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;
    validateWaitNumber("timeoutMs", timeoutMs, MAX_WAIT_TIMEOUT_MS);
    validateWaitNumber("pollIntervalMs", pollIntervalMs);
    if (pollIntervalMs < MIN_POLL_INTERVAL_MS) {
      throw new RangeError(`pollIntervalMs must be at least ${MIN_POLL_INTERVAL_MS}ms.`);
    }
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    let onTimeout: (() => void) | null = null;
    const abortFromCaller = () => controller.abort();
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      onTimeout?.();
    }, timeoutMs);
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });

    let initial: TaskRunDetailResponse;
    try {
      initial = await this.get(taskRunId, { signal: controller.signal });
    } catch (error) {
      clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", abortFromCaller);
      if (timedOut) throw new Error(`Timed out waiting for task ${taskRunId}.`);
      if (options.signal?.aborted) throw new DOMException("The task wait was aborted.", "AbortError");
      throw error;
    }
    if (isTerminal(initial.run.status)) {
      clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", abortFromCaller);
      return initial.run;
    }
    if (options.signal?.aborted) {
      clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", abortFromCaller);
      throw new DOMException("The task wait was aborted.", "AbortError");
    }

    const spaceId = initial.run.spaceId;

    return new Promise<TaskRunRecord>((resolve, reject) => {
      let settled = false;
      let pollTimer: ReturnType<typeof setTimeout> | null = null;
      let releaseRoom: (() => void) | null = null;
      let unsubscribe: (() => void) | null = null;
      let inspectInFlight = false;

      const cleanup = () => {
        if (pollTimer) clearTimeout(pollTimer);
        clearTimeout(timeoutTimer);
        onTimeout = null;
        options.signal?.removeEventListener("abort", abortFromCaller);
        options.signal?.removeEventListener("abort", onAbort);
        unsubscribe?.();
        releaseRoom?.();
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const inspect = async () => {
        if (settled || inspectInFlight) return;
        inspectInFlight = true;
        try {
          const detail = await this.get(taskRunId, { signal: controller.signal });
          if (isTerminal(detail.run.status)) {
            finish(() => resolve(detail.run));
            return;
          }
          if (!settled) pollTimer = setTimeout(inspect, Math.max(0, Math.min(pollIntervalMs, deadline - Date.now())));
        } catch (error) {
          if (timedOut) finish(() => reject(new Error(`Timed out waiting for task ${taskRunId}.`)));
          else if (options.signal?.aborted) finish(() => reject(new DOMException("The task wait was aborted.", "AbortError")));
          else finish(() => reject(error));
        } finally {
          inspectInFlight = false;
        }
      };
      const onEvent = (event: WebsocketEventPayload) => {
        if (event.type !== "task.updated") return;
        const task = (event.payload as { task?: { id?: unknown } }).task;
        if (task?.id !== taskRunId) return;
        void inspect();
      };

      const onAbort = () => finish(() => reject(new DOMException("The task wait was aborted.", "AbortError")));
      onTimeout = () => finish(() => reject(new Error(`Timed out waiting for task ${taskRunId}.`)));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      pollTimer = setTimeout(inspect, Math.max(0, Math.min(pollIntervalMs, deadline - Date.now())));

      if (this.websocketClient && spaceId) {
        ensureRealtimeConnected(this.websocketClient);
        releaseRoom = this.websocketClient.retainRooms([getRealtimeSpaceRoom(spaceId)]);
        unsubscribe = this.websocketClient.on("event", onEvent);
      }
    });
  }

  getMany(taskRunIds: string[], options?: { spaceId?: string }) {
    const ids = [...new Set(taskRunIds.filter(Boolean))];
    if (ids.length === 0) {
      return Promise.resolve({ runs: [] as TaskRunRecord[] });
    }
    if (ids.length > 100) throw new Error("At most 100 task runs can be fetched at once");
    return this.list({
      ids,
      spaceId: options?.spaceId,
      limit: ids.length,
    }).then(({ runs }) => ({ runs }));
  }

  list(filters?: { ids?: string[]; cronJobId?: string; spaceId?: string; sessionId?: string; taskType?: string; status?: "active" | TaskRunRecord["status"]; limit?: number; cursor?: string }) {
    const params = new URLSearchParams();
    if (filters?.ids?.length) params.set("ids", [...new Set(filters.ids)].join(","));
    if (filters?.cronJobId) params.set("cronJobId", filters.cronJobId);
    if (filters?.spaceId) params.set("spaceId", filters.spaceId);
    if (filters?.sessionId) params.set("sessionId", filters.sessionId);
    if (filters?.taskType) params.set("taskType", filters.taskType);
    if (filters?.status) params.set("status", filters.status);
    if (filters?.limit) params.set("limit", String(filters.limit));
    if (filters?.cursor) params.set("cursor", filters.cursor);
    const query = params.toString();
    return this.transport.request<{ runs: TaskRunRecord[]; pageInfo?: { hasMore: boolean; nextCursor: string | null } }>(
      `/api/tasks${query ? `?${query}` : ""}`,
    );
  }
}

