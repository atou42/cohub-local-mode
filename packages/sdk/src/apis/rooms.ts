import type {
  RealtimeRoomDescriptor,
  RealtimeRoomHistoryEvent,
  RealtimeRoomMember,
} from "@cohub/protocol/realtime";
import type { HttpTransport } from "../transport.js";

export type RoomView = {
  room: RealtimeRoomDescriptor;
  participantId: string;
  members: RealtimeRoomMember[];
  sequence: number;
};

export type RoomInvite = { invite: string; expiresAt: string };

export type RoomCreated = RoomInvite & {
  room: RealtimeRoomDescriptor;
  url: string | null;
};

export type RoomEvent = RealtimeRoomHistoryEvent & { self: boolean };

export type RoomEvents = {
  events: RoomEvent[];
  cursor: number;
  truncated: boolean;
};

export type RoomEventsQuery = {
  after?: number;
  types?: string[];
  waitMs?: number;
  limit?: number;
  signal?: AbortSignal;
};

const MAX_WAIT_PER_READ_MS = 25_000;

export class RoomsApi {
  constructor(private readonly transport: HttpTransport) {}

  create(input: { appId: string; code?: string; expiresInSeconds?: number; maxParticipants?: number; seatPerUser?: boolean }) {
    return this.post<RoomCreated>("", input);
  }

  join(input: { invite: string; presence?: Record<string, unknown> | null; idleSeconds?: number }) {
    return this.post<RoomView>("/join", input);
  }

  get(roomId: string) {
    return this.transport.request<RoomView>(this.path(roomId));
  }

  async events(roomId: string, query: RoomEventsQuery = {}): Promise<RoomEvents> {
    const deadline = Date.now() + Math.max(0, query.waitMs ?? 0);
    const result: RoomEvents = { events: [], cursor: query.after ?? 0, truncated: false };
    if (query.limit !== undefined && query.limit <= 0) return result;
    let after = query.after;
    for (;;) {
      const waitMs = Math.min(Math.max(0, deadline - Date.now()), MAX_WAIT_PER_READ_MS);
      const params = new URLSearchParams();
      if (after !== undefined) params.set("after", String(after));
      if (query.types?.length) params.set("types", query.types.join(","));
      if (query.limit !== undefined) params.set("limit", String(query.limit - result.events.length));
      if (waitMs > 0) params.set("wait", String(waitMs));
      const page = await this.transport.request<RoomEvents>(`${this.path(roomId)}/events?${params}`, { signal: query.signal });
      result.events.push(...page.events);
      result.cursor = page.cursor;
      result.truncated ||= page.truncated;
      const woken = result.events.some((event) => !event.self);
      if (woken || result.events.length >= (query.limit ?? Number.POSITIVE_INFINITY) || waitMs === 0 || Date.now() >= deadline || query.signal?.aborted) return result;
      after = page.cursor;
    }
  }

  publish(roomId: string, type: string, data?: unknown) {
    return this.post<{ sequence: number; eventId: string }>(`/${encodeURIComponent(roomId)}/events`, { type, data: data ?? null });
  }

  setPresence(roomId: string, presence: Record<string, unknown> | null) {
    return this.transport.request<{ member: RealtimeRoomMember; sequence: number }>(`${this.path(roomId)}/presence`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ presence }),
    });
  }

  invite(roomId: string, input: { expiresInSeconds?: number } = {}) {
    return this.post<RoomInvite>(`/${encodeURIComponent(roomId)}/invites`, input);
  }

  leave(roomId: string) {
    return this.transport.request<{ left: boolean }>(`${this.path(roomId)}/seat`, { method: "DELETE" });
  }

  private path(roomId: string) {
    return `/api/rooms/${encodeURIComponent(roomId)}`;
  }

  private post<T>(path: string, body: unknown) {
    return this.transport.request<T>(`/api/rooms${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}
