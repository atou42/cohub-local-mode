import type { RtcIceServers } from "@cohub/protocol/rtc";

export type RtcPath = "direct" | "relay";

export type RtcTransportStats = {
  path: RtcPath | null;
  relayProtocol: string | null;
  rttMs: number | null;
};

const ICE_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class IceServerCache {
  private cached: { value: RtcIceServers; refreshAt: number } | null = null;

  constructor(private readonly load: (signal?: AbortSignal) => Promise<RtcIceServers>) {}

  async get(signal?: AbortSignal): Promise<RtcIceServers> {
    if (this.cached && this.cached.refreshAt > Date.now()) return this.cached.value;
    const value = await this.load(signal);
    this.cached = { value, refreshAt: Date.parse(value.expiresAt) - ICE_REFRESH_MARGIN_MS };
    return value;
  }
}

export function waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      signal?.removeEventListener("abort", abort);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const abort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", check);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

type StatsEntry = Record<string, unknown>;

export const statNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function readRtcTransportStats(report: RTCStatsReport): RtcTransportStats {
  const stats: RtcTransportStats = { path: null, relayProtocol: null, rttMs: null };
  report.forEach((entry: StatsEntry) => {
    if (entry.type !== "candidate-pair" || !entry.nominated || entry.state !== "succeeded") return;
    const local = report.get(String(entry.localCandidateId)) as StatsEntry | undefined;
    const remote = report.get(String(entry.remoteCandidateId)) as StatsEntry | undefined;
    stats.path = local?.candidateType === "relay" || remote?.candidateType === "relay" ? "relay" : "direct";
    if (local?.candidateType === "relay" && typeof local.relayProtocol === "string") stats.relayProtocol = local.relayProtocol;
    const rtt = statNumber(entry.currentRoundTripTime);
    if (rtt !== null) stats.rttMs = Math.round(rtt * 1000);
  });
  return stats;
}
