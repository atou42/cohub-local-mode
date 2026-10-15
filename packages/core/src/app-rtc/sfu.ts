import type { SessionDescription } from "@cohub/protocol/rtc";

const DEFAULT_BASE_URL = "https://rtc.live.cloudflare.com/v1";
const REQUEST_TIMEOUT_MS = 10_000;

export type SfuItemError = { errorCode?: string; errorDescription?: string };

export type SfuTrackResult = SfuItemError & {
  mid?: string;
  trackName?: string;
  sessionId?: string;
};

export type SfuDataChannelResult = SfuItemError & {
  id?: number;
  dataChannelName?: string;
  location?: "local" | "remote";
  sessionId?: string;
};

export type SfuNegotiationResult = {
  sessionDescription?: SessionDescription;
  requiresImmediateRenegotiation?: boolean;
};

export type SfuSimulcastPreference = { preferredRid: string };

const simulcastOf = (preference: SfuSimulcastPreference | undefined) =>
  preference ? { simulcast: { ...preference, priorityOrdering: "asciibetical", ridNotAvailable: "asciibetical" } } : {};

export type SfuDataChannelPolicy = {
  ordered?: boolean;
  maxRetransmits?: number;
};

export class SfuError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = "SfuError";
  }
}

const ALREADY_CLOSED = new Set(["close_track_error", "not_found"]);

function assertClosed<T extends SfuItemError>(keys: Array<string | number>, items: T[] | undefined, keyOf: (item: T) => string | number | undefined) {
  const results = new Map((items ?? []).map((item) => [keyOf(item), item]));
  const failed = keys.filter((key) => {
    const item = results.get(key);
    return !item || (item.errorCode !== undefined && !ALREADY_CLOSED.has(item.errorCode));
  });
  if (failed.length) throw new SfuError(`the relay did not close ${failed.join(", ")}`, 200, "close_incomplete");
}

export type SfuConfig = {
  appId: string;
  appSecret: string;
  baseUrl?: string;
};

export class SfuClient {
  constructor(
    private readonly config: SfuConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl ?? DEFAULT_BASE_URL}/apps/${encodeURIComponent(this.config.appId)}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.config.appSecret}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new SfuError(error instanceof Error ? error.message : "SFU request failed", 0, "network_error");
    }
    const data = (await response.json().catch(() => null)) as (T & SfuItemError) | null;
    if (!response.ok || data?.errorCode) {
      throw new SfuError(data?.errorDescription ?? `SFU responded ${response.status}`, response.status, data?.errorCode ?? null);
    }
    return data as T;
  }

  async createSession(): Promise<string> {
    const { sessionId } = await this.request<{ sessionId: string }>("POST", "/sessions/new");
    return sessionId;
  }

  establishDataChannels(sessionId: string) {
    return this.request<SfuNegotiationResult & { dataChannel?: SfuDataChannelResult }>(
      "POST",
      `/sessions/${sessionId}/datachannels/establish`,
      { dataChannel: { location: "remote", dataChannelName: "server-events" } },
    );
  }

  publishDataChannels(sessionId: string, channels: Array<{ name: string } & SfuDataChannelPolicy>) {
    return this.request<{ dataChannels: SfuDataChannelResult[] }>("POST", `/sessions/${sessionId}/datachannels/new`, {
      dataChannels: channels.map(({ name, ...policy }) => ({ location: "local", dataChannelName: name, ...policy })),
    });
  }

  subscribeDataChannels(sessionId: string, channels: Array<{ name: string; publisherSessionId: string } & SfuDataChannelPolicy>) {
    return this.request<{ dataChannels: SfuDataChannelResult[] }>("POST", `/sessions/${sessionId}/datachannels/new`, {
      dataChannels: channels.map(({ name, publisherSessionId, ...policy }) => ({
        location: "remote",
        sessionId: publisherSessionId,
        dataChannelName: name,
        ...policy,
      })),
    });
  }

  async closeDataChannels(sessionId: string, ids: number[]) {
    const result = await this.request<{ dataChannels: SfuDataChannelResult[] }>("PUT", `/sessions/${sessionId}/datachannels/close`, {
      dataChannels: ids.map((id) => ({ id })),
    });
    assertClosed(ids, result.dataChannels, (item) => item.id);
    return result;
  }

  publishTracks(sessionId: string, offer: SessionDescription, tracks: Array<{ mid: string; trackName: string }>) {
    return this.request<SfuNegotiationResult & { tracks: SfuTrackResult[] }>("POST", `/sessions/${sessionId}/tracks/new`, {
      sessionDescription: offer,
      tracks: tracks.map((track) => ({ location: "local", ...track })),
    });
  }

  subscribeTracks(sessionId: string, tracks: Array<{ publisherSessionId: string; trackName: string; simulcast?: SfuSimulcastPreference }>) {
    return this.request<SfuNegotiationResult & { tracks: SfuTrackResult[] }>("POST", `/sessions/${sessionId}/tracks/new`, {
      tracks: tracks.map(({ publisherSessionId, trackName, simulcast }) => ({
        location: "remote",
        sessionId: publisherSessionId,
        trackName,
        ...simulcastOf(simulcast),
      })),
    });
  }

  updateTracks(sessionId: string, tracks: Array<{ mid: string; publisherSessionId: string; trackName: string; simulcast?: SfuSimulcastPreference }>) {
    return this.request<SfuNegotiationResult & { tracks: SfuTrackResult[] }>("PUT", `/sessions/${sessionId}/tracks/update`, {
      tracks: tracks.map(({ mid, publisherSessionId, trackName, simulcast }) => ({
        location: "remote",
        mid,
        sessionId: publisherSessionId,
        trackName,
        ...simulcastOf(simulcast),
      })),
    });
  }

  async closeTracks(sessionId: string, mids: string[], offer?: SessionDescription) {
    const result = await this.request<SfuNegotiationResult & { tracks: SfuTrackResult[] }>("PUT", `/sessions/${sessionId}/tracks/close`, {
      tracks: mids.map((mid) => ({ mid })),
      ...(offer ? { sessionDescription: offer, force: false } : { force: true }),
    });
    assertClosed(mids, result.tracks, (item) => item.mid);
    return result;
  }

  renegotiate(sessionId: string, answer: SessionDescription) {
    return this.request<SfuNegotiationResult>("PUT", `/sessions/${sessionId}/renegotiate`, { sessionDescription: answer });
  }
}
