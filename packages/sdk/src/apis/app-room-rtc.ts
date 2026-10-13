import {
  APP_RTC_LIMITS,
  APP_RTC_SIMULCAST_LAYERS,
  type AppRtcDelivery,
  type AppRtcMediaKind,
  type AppRtcMediaUpdateResponse,
  type AppRtcOpenResponse,
  type AppRtcPublication,
  type AppRtcPublishResponse,
  type AppRtcQuality,
  type AppRtcSubscribeResponse,
  type AppRtcSubscriptionRef,
  type AppRtcUnpublishResponse,
  type AppRtcUnsubscribeResponse,
  isAppRtcName,
  type SessionDescription,
} from "@cohub/protocol/rtc";
import type { RealtimeRoomMember } from "@cohub/protocol/realtime";
import { readRtcTransportStats, type RtcTransportStats, waitForIceGathering } from "../rtc/index.js";
import { HttpError, type HttpTransport } from "../transport.js";

export type AppRtcState = "connecting" | "connected" | "reconnecting" | "closed";

export type AppRtcErrorCode =
  | "RTC_UNSUPPORTED"
  | "RTC_UNAVAILABLE"
  | "RTC_FORBIDDEN"
  | "RTC_LIMIT_EXCEEDED"
  | "RTC_RATE_LIMITED"
  | "RTC_CLOSED"
  | "ROOM_NOT_FOUND"
  | "ROOM_EXPIRED"
  | "RTC_FAILED";

export class AppRtcError extends Error {
  constructor(readonly code: AppRtcErrorCode, message: string) {
    super(message);
    this.name = "AppRtcError";
  }
}

const SERVER_CODES = new Set<AppRtcErrorCode>([
  "RTC_UNAVAILABLE",
  "RTC_FORBIDDEN",
  "RTC_LIMIT_EXCEEDED",
  "RTC_RATE_LIMITED",
  "ROOM_NOT_FOUND",
  "ROOM_EXPIRED",
]);

export const toAppRtcError = (error: unknown): AppRtcError => {
  if (error instanceof AppRtcError) return error;
  if (error instanceof HttpError && SERVER_CODES.has(error.code as AppRtcErrorCode)) {
    return new AppRtcError(error.code as AppRtcErrorCode, error.message);
  }
  return new AppRtcError("RTC_FAILED", error instanceof Error ? error.message : String(error));
};

export type AppRtcMessage<T = unknown> = {
  from: string;
  data: T | ArrayBuffer;
};

export type AppRtcChannelOptions = {
  delivery?: AppRtcDelivery;
};

export type AppRtcPeerEvent = { participantId: string; open: boolean };

export type AppRtcCandidate = {
  participantId: string;
  name: string;
  kind: AppRtcMediaKind;
  simulcast: boolean;
  subscribed: boolean;
};

export type AppRtcRemoteTrack = {
  participantId: string;
  name: string;
  kind: AppRtcMediaKind;
  track: MediaStreamTrack;
  quality: AppRtcQuality | null;
  setQuality(quality: AppRtcQuality): Promise<void>;
};

export type AppRtcTrackInput = MediaStreamTrack | { track: MediaStreamTrack; simulcast?: boolean };

export type AppRtcLocalTrack = {
  readonly name: string;
  readonly kind: AppRtcMediaKind;
  readonly track: MediaStreamTrack;
  readonly simulcast: boolean;
  replace(track: MediaStreamTrack): Promise<void>;
  onEnded(handler: () => void): () => void;
  stop(): Promise<void>;
};

export type AppRtcHost = {
  roomId: string;
  appId: string;
  ticket: string;
  transport: HttpTransport;
  participantId(): string;
  members(): RealtimeRoomMember[];
  onMembersChanged(handler: (members: RealtimeRoomMember[]) => void): () => void;
};

const HEADER_BYTES = 5;
const FLAG_BINARY = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeAppRtcFrame(data: unknown, sequence: number): Uint8Array {
  let payload: Uint8Array;
  let flags = 0;
  if (data instanceof ArrayBuffer) {
    payload = new Uint8Array(data);
    flags = FLAG_BINARY;
  } else if (ArrayBuffer.isView(data)) {
    payload = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    flags = FLAG_BINARY;
  } else {
    const json = JSON.stringify(data);
    if (json === undefined) throw new TypeError("RTC message is not serializable");
    payload = encoder.encode(json);
  }
  if (payload.byteLength > APP_RTC_LIMITS.messageBytes) {
    throw new RangeError(`RTC message exceeds ${APP_RTC_LIMITS.messageBytes} bytes`);
  }
  const frame = new Uint8Array(HEADER_BYTES + payload.byteLength);
  frame[0] = flags;
  new DataView(frame.buffer).setUint32(1, sequence >>> 0);
  frame.set(payload, HEADER_BYTES);
  return frame;
}

function decodeAppRtcFrame(frame: ArrayBuffer): { data: unknown; sequence: number } | null {
  if (frame.byteLength < HEADER_BYTES) return null;
  const view = new DataView(frame);
  const flags = view.getUint8(0);
  const sequence = view.getUint32(1);
  const payload = new Uint8Array(frame, HEADER_BYTES);
  if (flags & FLAG_BINARY) return { data: payload.slice().buffer, sequence };
  try {
    return { data: JSON.parse(decoder.decode(payload)), sequence };
  } catch {
    return null;
  }
}

const isNewerSequence = (next: number, last: number | null) =>
  last === null || (next !== last && ((next - last) >>> 0) < 0x8000_0000);

const publicationsKey = (members: readonly RealtimeRoomMember[]) =>
  members.map((member) => `${member.participantId}:${member.publications?.map((item) => item.id).join(",") ?? ""}`).join(";");

const GATHER_TIMEOUT_MS = 2_000;
const CONNECT_TIMEOUT_MS = 15_000;
const PENDING_RELIABLE_FRAMES = 256;
const LATEST_BACKLOG_BYTES = 64 * 1024;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000];
const RATE_LIMIT_RETRY_MS = 1_000;

class ConnectionReplacedError extends Error {
  constructor() {
    super("RTC connection was replaced");
    this.name = "ConnectionReplacedError";
  }
}

const policyOf = (delivery: AppRtcDelivery): RTCDataChannelInit =>
  delivery === "latest" ? { ordered: false, maxRetransmits: 0 } : { ordered: true };

const isSessionLost = (error: unknown) =>
  error instanceof HttpError && (error.code === "RTC_STALE" || error.code === "RTC_SESSION_NOT_FOUND");

const isRoomGone = (error: unknown) =>
  error instanceof HttpError && (error.code === "ROOM_NOT_FOUND" || error.code === "ROOM_EXPIRED");

const chunk = <T>(items: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
};

const mediaKey = (participantId: string, publicationId: string) => `${participantId}:${publicationId}`;

type RemoteData = { name: string; participantId: string; publicationId: string; channel: RTCDataChannel; last: number | null };
type WantedMedia = AppRtcSubscriptionRef & { name: string; kind: AppRtcMediaKind; quality?: AppRtcQuality };
type RemoteMedia = WantedMedia & { mid: string; track: MediaStreamTrack | null };
type LocalEntry = {
  name: string;
  kind: AppRtcMediaKind;
  track: MediaStreamTrack;
  simulcast: boolean;
  transceiver: RTCRtpTransceiver | null;
  id: string | null;
  ended: Set<() => void>;
  onEnded: () => void;
};

export class AppRtcChannel<T = unknown> {
  private readonly handlers = new Set<(message: AppRtcMessage<T>) => void>();
  private readonly peerHandlers = new Set<(event: AppRtcPeerEvent) => void>();
  private readonly openPeers = new Set<string>();
  private publication: { id: string; channel: RTCDataChannel } | null = null;
  private pending: Uint8Array[] = [];
  private sequence = 0;
  private closed = false;

  constructor(
    private readonly rtc: AppRoomRtc,
    readonly name: string,
    readonly delivery: AppRtcDelivery,
  ) {}

  get peers(): string[] {
    return [...this.openPeers];
  }

  send(data: T | ArrayBuffer | ArrayBufferView): boolean {
    if (this.closed || this.rtc.state === "closed") return false;
    this.sequence = (this.sequence + 1) >>> 0;
    const frame = encodeAppRtcFrame(data, this.sequence);
    const channel = this.publication?.channel;
    if (channel?.readyState === "open") return this.write(channel, frame);
    if (this.delivery === "latest") this.pending = [frame];
    else if (this.pending.length >= PENDING_RELIABLE_FRAMES) return false;
    else this.pending.push(frame);
    return true;
  }

  onMessage(handler: (message: AppRtcMessage<T>) => void) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Reports when this client starts or stops receiving a peer's channel. */
  onPeer(handler: (event: AppRtcPeerEvent) => void) {
    this.peerHandlers.add(handler);
    return () => this.peerHandlers.delete(handler);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();
    this.peerHandlers.clear();
    this.openPeers.clear();
    this.pending = [];
    this.rtc.closeChannel(this as AppRtcChannel<unknown>);
  }

  /** @internal */
  get isOpen() {
    return !this.closed;
  }

  /** @internal */
  get publicationId() {
    return this.publication?.id ?? null;
  }

  /** @internal */
  attach(id: string, channel: RTCDataChannel) {
    this.publication = { id, channel };
    channel.binaryType = "arraybuffer";
    const flush = () => {
      const frames = this.pending;
      this.pending = [];
      for (const frame of frames) this.write(channel, frame);
    };
    if (channel.readyState === "open") flush();
    else channel.addEventListener("open", flush, { once: true });
  }

  /** @internal */
  detach() {
    this.publication = null;
  }

  /** @internal */
  fail() {
    this.close();
  }

  /** @internal */
  deliver(from: string, data: unknown) {
    for (const handler of this.handlers) handler({ from, data: data as T | ArrayBuffer });
  }

  /** @internal */
  setPeer(participantId: string, open: boolean) {
    if (open ? this.openPeers.has(participantId) : !this.openPeers.delete(participantId)) return;
    if (open) this.openPeers.add(participantId);
    for (const handler of this.peerHandlers) handler({ participantId, open });
  }

  private write(channel: RTCDataChannel, frame: Uint8Array) {
    if (this.delivery === "latest" && channel.bufferedAmount > LATEST_BACKLOG_BYTES) return false;
    try {
      channel.send(frame as Uint8Array<ArrayBuffer>);
      return true;
    } catch {
      return false;
    }
  }
}

export class AppRoomRtc {
  private _state: AppRtcState = "connecting";
  private pc: RTCPeerConnection | null = null;
  private sessionId: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private reconcileQueued = false;
  private reconcileFailures = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private filter: ((candidate: AppRtcCandidate) => boolean) | null = null;
  private readonly channels = new Map<string, AppRtcChannel<unknown>>();
  private readonly channelsToPublish = new Set<AppRtcChannel<unknown>>();
  private readonly remoteData = new Map<string, RemoteData>();
  private readonly localTracks = new Map<string, LocalEntry>();
  private readonly remoteMedia = new Map<string, RemoteMedia>();
  private readonly mediaByMid = new Map<string, string>();
  private readonly stateHandlers = new Set<(state: AppRtcState) => void>();
  private readonly trackHandlers = new Set<(tracks: AppRtcRemoteTrack[]) => void>();
  private readonly offMembers: () => void;

  constructor(private readonly host: AppRtcHost) {
    let published = "";
    this.offMembers = host.onMembersChanged((members) => {
      const next = publicationsKey(members);
      if (next === published) return;
      published = next;
      this.scheduleReconcile();
    });
  }

  get state() {
    return this._state;
  }

  get tracks(): AppRtcRemoteTrack[] {
    const tracks: AppRtcRemoteTrack[] = [];
    for (const [key, item] of this.remoteMedia) {
      if (!item.track) continue;
      tracks.push({
        participantId: item.participantId,
        name: item.name,
        kind: item.kind,
        track: item.track,
        quality: item.quality ?? null,
        setQuality: (quality) => this.setQuality(key, quality),
      });
    }
    return tracks;
  }

  get candidates(): AppRtcCandidate[] {
    return this.mediaCandidates().map(({ candidate }) => candidate);
  }

  onStateChange(handler: (state: AppRtcState) => void) {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  onTracksChanged(handler: (tracks: AppRtcRemoteTrack[]) => void) {
    this.trackHandlers.add(handler);
    return () => this.trackHandlers.delete(handler);
  }

  select(filter: ((candidate: AppRtcCandidate) => boolean) | null) {
    this.filter = filter;
    this.scheduleReconcile();
  }

  channel<T = unknown>(name: string, options: AppRtcChannelOptions = {}): AppRtcChannel<T> {
    if (!isAppRtcName(name)) throw new AppRtcError("RTC_FAILED", `invalid RTC channel name: ${name}`);
    const delivery = options.delivery ?? "reliable";
    const existing = this.channels.get(name);
    if (existing?.isOpen) {
      if (existing.delivery !== delivery) throw new AppRtcError("RTC_FAILED", `RTC channel ${name} is already open with ${existing.delivery} delivery`);
      return existing as AppRtcChannel<T>;
    }
    if (this._state === "closed") throw new AppRtcError("RTC_CLOSED", "RTC connection is closed");
    const channel = new AppRtcChannel<T>(this, name, delivery);
    this.channels.set(name, channel as AppRtcChannel<unknown>);
    this.publishChannel(channel as AppRtcChannel<unknown>);
    this.scheduleReconcile();
    return channel;
  }

  async publish<Names extends string>(tracks: Record<Names, AppRtcTrackInput>): Promise<Record<Names, AppRtcLocalTrack>> {
    if (this._state === "closed") throw new AppRtcError("RTC_CLOSED", "RTC connection is closed");
    const inputs = Object.entries<AppRtcTrackInput>(tracks);
    for (const [name] of inputs) {
      if (!isAppRtcName(name)) throw new AppRtcError("RTC_FAILED", `invalid RTC track name: ${name}`);
      if (this.localTracks.has(name)) throw new AppRtcError("RTC_FAILED", `RTC track ${name} is already published`);
    }
    if (this.localTracks.size + inputs.length > APP_RTC_LIMITS.tracksPerMember) {
      throw new AppRtcError("RTC_LIMIT_EXCEEDED", `at most ${APP_RTC_LIMITS.tracksPerMember} tracks per member`);
    }
    const entries = inputs.map(([name, input]) => {
      const { track, simulcast } = "track" in input ? input : { track: input, simulcast: false };
      const kind: AppRtcMediaKind = track.kind === "audio" ? "audio" : "video";
      return this.localEntry(name, kind, track, simulcast === true && kind === "video");
    });
    for (const entry of entries) this.localTracks.set(entry.name, entry);
    try {
      await this.enqueue(() => this.publishTracks(entries.map((entry) => entry.name)));
    } catch (error) {
      if (!(error instanceof ConnectionReplacedError)) {
        for (const entry of entries) this.dropLocal(entry);
        throw toAppRtcError(error);
      }
    }
    return Object.fromEntries(entries.map((entry) => [entry.name, this.localHandle(entry)])) as Record<Names, AppRtcLocalTrack>;
  }

  async stats(): Promise<RtcTransportStats> {
    return this.pc ? readRtcTransportStats(await this.pc.getStats()) : { path: null, relayProtocol: null, rttMs: null };
  }

  close() {
    if (this._state === "closed") return;
    this.setState("closed");
    this.offMembers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const channel of this.channels.values()) channel.close();
    for (const entry of this.localTracks.values()) entry.track.removeEventListener("ended", entry.onEnded);
    this.teardown(true);
  }

  /** @internal */
  async start() {
    try {
      await this.connect();
    } catch (error) {
      throw toAppRtcError(error);
    }
  }

  /** @internal */
  async verify() {
    if (this._state === "closed" || !this.sessionId) return;
    try {
      await this.request("GET", `/${this.sessionId}`);
    } catch (error) {
      if (isSessionLost(error)) this.reconnect();
    }
  }

  /** @internal */
  closeChannel(channel: AppRtcChannel<unknown>) {
    if (this.channels.get(channel.name) === channel) this.channels.delete(channel.name);
    const id = channel.publicationId;
    channel.detach();
    if (id) void this.enqueue(() => this.unpublishData([id])).catch(() => undefined);
    this.scheduleReconcile();
  }


  private localEntry(name: string, kind: AppRtcMediaKind, track: MediaStreamTrack, simulcast: boolean): LocalEntry {
    const entry: LocalEntry = { name, kind, track, simulcast, transceiver: null, id: null, ended: new Set(), onEnded: () => undefined };
    entry.onEnded = () => {
      if (this.localTracks.get(name) !== entry) return;
      for (const handler of entry.ended) handler();
      void this.stopLocal(entry).catch(() => undefined);
    };
    track.addEventListener("ended", entry.onEnded);
    return entry;
  }

  private localHandle(entry: LocalEntry): AppRtcLocalTrack {
    return {
      name: entry.name,
      kind: entry.kind,
      simulcast: entry.simulcast,
      get track() {
        return entry.track;
      },
      replace: async (track) => {
        if (track.kind !== entry.kind) throw new AppRtcError("RTC_FAILED", `replace ${entry.name} with another ${entry.kind} track`);
        if (this.localTracks.get(entry.name) !== entry) throw new AppRtcError("RTC_CLOSED", `RTC track ${entry.name} has stopped`);
        entry.track.removeEventListener("ended", entry.onEnded);
        entry.track = track;
        track.addEventListener("ended", entry.onEnded);
        await entry.transceiver?.sender.replaceTrack(track);
      },
      onEnded: (handler) => {
        entry.ended.add(handler);
        return () => entry.ended.delete(handler);
      },
      stop: () => this.stopLocal(entry),
    };
  }

  private dropLocal(entry: LocalEntry) {
    entry.track.removeEventListener("ended", entry.onEnded);
    if (this.localTracks.get(entry.name) === entry) this.localTracks.delete(entry.name);
  }

  private stopLocal(entry: LocalEntry) {
    if (this.localTracks.get(entry.name) !== entry) return Promise.resolve();
    this.dropLocal(entry);
    return this.enqueue(() => this.unpublishTrack(entry)).catch((error) => {
      if (error instanceof ConnectionReplacedError) return;
      throw toAppRtcError(error);
    });
  }

  private async publishTracks(names: string[]) {
    const pc = this.requirePc();
    const entries = names.flatMap((name) => {
      const entry = this.localTracks.get(name);
      return entry && !entry.id ? [entry] : [];
    });
    if (entries.length === 0) return;
    for (const entry of entries) {
      entry.transceiver = pc.addTransceiver(entry.track, {
        direction: "sendonly",
        ...(entry.simulcast
          ? { sendEncodings: APP_RTC_SIMULCAST_LAYERS.map(({ rid, scaleResolutionDownBy }) => ({ rid, scaleResolutionDownBy })) }
          : {}),
      });
    }
    const offer = await this.localOffer(pc);
    let result: AppRtcPublishResponse;
    try {
      result = await this.request<AppRtcPublishResponse>("POST", `/${this.sessionId}/publish`, {
        offer,
        tracks: entries.map((entry) => ({
          name: entry.name,
          kind: entry.kind,
          mid: entry.transceiver?.mid ?? "",
          ...(entry.simulcast ? { simulcast: true } : {}),
        })),
      });
    } catch (error) {
      if (error instanceof ConnectionReplacedError) throw error;
      await this.settleOffer(pc, undefined).catch(() => undefined);
      for (const entry of entries) {
        entry.transceiver?.stop();
        entry.transceiver = null;
      }
      throw error;
    }
    await this.settleOffer(pc, result.answer);
    for (const publication of result.publications) {
      const entry = entries.find((candidate) => candidate.name === publication.name);
      if (entry) entry.id = publication.id;
    }
  }

  private async unpublishTrack(entry: LocalEntry) {
    if (!entry.id || !entry.transceiver || !this.pc) return;
    const id = entry.id;
    entry.transceiver.stop();
    await this.offerExchange(this.pc, (offer) =>
      this.request<AppRtcUnpublishResponse>("POST", `/${this.sessionId}/unpublish`, { ids: [id], offer }),
    );
    entry.id = null;
  }


  private publishChannel(channel: AppRtcChannel<unknown>) {
    this.channelsToPublish.add(channel);
    if (this.channelsToPublish.size > 1 || !this.pc) return;
    void this.enqueue(async () => {
      const batch = [...this.channelsToPublish];
      this.channelsToPublish.clear();
      try {
        await this.publishChannels(batch);
      } catch (error) {
        if (isSessionLost(error) || error instanceof ConnectionReplacedError) throw error;
        if (error instanceof HttpError && error.code === "RTC_RATE_LIMITED") {
          setTimeout(() => {
            for (const item of batch) if (item.isOpen) this.publishChannel(item);
          }, RATE_LIMIT_RETRY_MS);
          return;
        }
        for (const item of batch) item.fail();
        console.warn("[Cohub AppRtc] failed to publish channels", error);
      }
    }).catch(() => undefined);
  }

  private async connect() {
    const generation = ++this.generation;
    const opened = await this.send<AppRtcOpenResponse>("POST", "", {
      ticket: this.host.ticket,
      participantId: this.host.participantId(),
    });
    if (generation !== this.generation || this._state === "closed") {
      void this.send("DELETE", `/${opened.sessionId}`).catch(() => undefined);
      return;
    }
    const pc = new RTCPeerConnection({ iceServers: opened.iceServers, bundlePolicy: "max-bundle" });
    this.pc = pc;
    this.sessionId = opened.sessionId;
    pc.addEventListener("connectionstatechange", () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === "connected") {
        this.reconnectAttempt = 0;
        this.setState("connected");
      } else if (pc.connectionState === "failed") {
        this.reconnect();
      }
    });
    pc.addEventListener("track", (event) => this.onTrack(event));

    const ready = (async () => {
      await this.answerOffer(opened.offer);
      await this.connected(pc);
    })();
    this.queue = ready.catch(() => undefined);
    try {
      await ready;
    } catch (error) {
      if (generation === this.generation) this.reconnect();
      throw error;
    }
    this.channelsToPublish.clear();
    const republish = [...this.channels.values()].filter((channel) => channel.isOpen);
    const tracks = [...this.localTracks.keys()];
    await Promise.all([
      republish.length
        ? this.enqueue(() => this.publishChannels(republish)).catch((error) => {
            if (error instanceof ConnectionReplacedError || isSessionLost(error)) return;
            for (const channel of republish) channel.fail();
            console.warn("[Cohub AppRtc] failed to publish channels on the new connection", error);
          })
        : null,
      tracks.length
        ? this.enqueue(() => this.publishTracks(tracks)).catch((error) => {
            if (error instanceof ConnectionReplacedError || isSessionLost(error)) return;
            console.warn("[Cohub AppRtc] failed to publish tracks on the new connection", error);
          })
        : null,
    ]);
    this.scheduleReconcile();
  }

  private connected(pc: RTCPeerConnection) {
    if (pc.connectionState === "connected") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => done(new Error("RTC connection timed out")), CONNECT_TIMEOUT_MS);
      const done = (error?: Error) => {
        clearTimeout(timer);
        pc.removeEventListener("connectionstatechange", check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (pc.connectionState === "connected") done();
        else if (pc.connectionState === "failed" || pc.connectionState === "closed") done(new Error("RTC connection failed"));
      };
      pc.addEventListener("connectionstatechange", check);
    });
  }

  private reconnect() {
    if (this._state === "closed" || this.reconnectTimer) return;
    this.setState(this._state === "connecting" ? "connecting" : "reconnecting");
    this.teardown(true);
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ?? 30_000;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((error) => {
        if (isRoomGone(error) || (error instanceof HttpError && (error.status === 403 || error.status === 503))) this.close();
        else this.reconnect();
      });
    }, delay);
  }

  private teardown(release: boolean) {
    this.generation += 1;
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.queue = Promise.resolve();
    for (const channel of this.channels.values()) channel.detach();
    for (const item of this.remoteData.values()) this.dropRemoteData(item);
    this.remoteData.clear();
    for (const item of this.localTracks.values()) {
      item.transceiver = null;
      item.id = null;
    }
    const hadTracks = this.remoteMedia.size > 0;
    this.remoteMedia.clear();
    this.mediaByMid.clear();
    this.pc?.close();
    this.pc = null;
    if (hadTracks) this.notifyTracks();
    if (release && sessionId) void this.send("DELETE", `/${sessionId}`).catch(() => undefined);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    const run = async () => {
      if (generation !== this.generation || !this.pc || !this.sessionId) throw new ConnectionReplacedError();
      try {
        return await operation();
      } catch (error) {
        if (isSessionLost(error)) this.reconnect();
        throw error;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async publishChannels(channels: AppRtcChannel<unknown>[]) {
    const pc = this.requirePc();
    const open = channels.filter((channel) => channel.isOpen && !channel.publicationId);
    if (open.length === 0) return;
    const result = await this.request<AppRtcPublishResponse>("POST", `/${this.sessionId}/publish`, {
      channels: open.map((channel) => ({ name: channel.name, delivery: channel.delivery })),
    });
    for (const publication of result.publications) {
      const channel = open.find((item) => item.name === publication.name);
      const id = result.channelIds?.[publication.id];
      if (!channel || id === undefined) continue;
      const dataChannel = pc.createDataChannel(publication.name, { negotiated: true, id, ...policyOf(channel.delivery) });
      channel.attach(publication.id, dataChannel);
      if (!channel.isOpen) await this.unpublishData([publication.id]);
    }
  }

  private async unpublishData(ids: string[]) {
    await this.request<AppRtcUnpublishResponse>("POST", `/${this.sessionId}/unpublish`, { ids });
  }

  private async settleOffer(pc: RTCPeerConnection, answer: SessionDescription | undefined) {
    if (answer) await pc.setRemoteDescription(answer);
    else if (pc.signalingState === "have-local-offer") await pc.setLocalDescription({ type: "rollback" });
  }

  private async offerExchange(pc: RTCPeerConnection, send: (offer: SessionDescription) => Promise<{ answer?: SessionDescription }>) {
    const offer = await this.localOffer(pc);
    let answer: SessionDescription | undefined;
    try {
      ({ answer } = await send(offer));
    } catch (error) {
      if (!(error instanceof ConnectionReplacedError)) await this.settleOffer(pc, undefined).catch(() => undefined);
      throw error;
    }
    await this.settleOffer(pc, answer);
  }


  private scheduleReconcile() {
    if (this.reconcileQueued || !this.pc || this._state === "closed") return;
    this.reconcileQueued = true;
    void this.enqueue(async () => {
      this.reconcileQueued = false;
      await this.reconcile();
      this.reconcileFailures = 0;
    }).catch((error) => {
      this.reconcileQueued = false;
      if (isSessionLost(error) || error instanceof ConnectionReplacedError) return;
      console.warn("[Cohub AppRtc] failed to update subscriptions", error);
      if (error instanceof HttpError && error.code === "RTC_LIMIT_EXCEEDED") return;
      const delay = RECONNECT_DELAYS_MS[Math.min(this.reconcileFailures, RECONNECT_DELAYS_MS.length - 1)] ?? 30_000;
      this.reconcileFailures += 1;
      const generation = this.generation;
      setTimeout(() => {
        if (generation === this.generation) this.scheduleReconcile();
      }, delay);
    });
  }

  private mediaCandidates() {
    const self = this.host.participantId();
    const candidates: Array<{ candidate: AppRtcCandidate; publication: AppRtcPublication }> = [];
    for (const member of this.host.members()) {
      if (member.participantId === self) continue;
      for (const publication of member.publications ?? []) {
        if (publication.kind === "data") continue;
        candidates.push({
          publication,
          candidate: {
            participantId: member.participantId,
            name: publication.name,
            kind: publication.kind,
            simulcast: publication.simulcast === true,
            subscribed: this.remoteMedia.has(mediaKey(member.participantId, publication.id)),
          },
        });
      }
    }
    return candidates;
  }

  private async reconcile() {
    const self = this.host.participantId();
    const wantedData = new Map<string, AppRtcSubscriptionRef & { name: string; delivery: AppRtcDelivery }>();
    for (const member of this.host.members()) {
      if (member.participantId === self) continue;
      for (const publication of member.publications ?? []) {
        if (publication.kind !== "data") continue;
        const channel = this.channels.get(publication.name);
        if (channel?.isOpen && channel.delivery === (publication.delivery ?? "reliable")) {
          wantedData.set(mediaKey(member.participantId, publication.id), {
            participantId: member.participantId,
            publicationId: publication.id,
            name: publication.name,
            delivery: channel.delivery,
          });
        }
      }
    }
    const wantedMedia = new Map<string, WantedMedia>();
    for (const { candidate, publication } of this.mediaCandidates()) {
      if (wantedMedia.size >= APP_RTC_LIMITS.mediaSubscriptions) break;
      if (this.filter && !this.filter(candidate)) continue;
      const key = mediaKey(candidate.participantId, publication.id);
      const quality = this.remoteMedia.get(key)?.quality ?? (candidate.simulcast ? "high" : undefined);
      wantedMedia.set(key, {
        participantId: candidate.participantId,
        publicationId: publication.id,
        name: candidate.name,
        kind: candidate.kind,
        ...(quality ? { quality } : {}),
      });
    }
    await this.reconcileData(wantedData);
    await this.reconcileMedia(wantedMedia);
    if ([...wantedData.keys()].some((key) => !this.remoteData.has(key)) ||
        [...wantedMedia.keys()].some((key) => !this.remoteMedia.has(key))) {
      throw new AppRtcError("RTC_FAILED", "Some RTC subscriptions could not be established");
    }
  }

  private dropRemoteData(item: RemoteData) {
    item.channel.close();
    this.channels.get(item.name)?.setPeer(item.participantId, false);
  }

  private async reconcileData(wanted: Map<string, AppRtcSubscriptionRef & { name: string; delivery: AppRtcDelivery }>) {
    const pc = this.requirePc();
    const stale = [...this.remoteData].filter(([key]) => !wanted.has(key));
    for (const batch of chunk(stale, APP_RTC_LIMITS.batch)) {
      await this.request<AppRtcUnsubscribeResponse>("POST", `/${this.sessionId}/unsubscribe`, {
        items: batch.map(([, item]) => ({ participantId: item.participantId, publicationId: item.publicationId })),
      });
      for (const [key, item] of batch) {
        this.dropRemoteData(item);
        this.remoteData.delete(key);
      }
    }
    const missing = [...wanted].filter(([key]) => !this.remoteData.has(key)).map(([, item]) => item);
    for (const batch of chunk(missing, APP_RTC_LIMITS.batch)) {
      const result = await this.request<AppRtcSubscribeResponse>("POST", `/${this.sessionId}/subscribe`, {
        kind: "data",
        items: batch.map(({ participantId, publicationId }) => ({ participantId, publicationId })),
      });
      for (const subscription of result.subscriptions) {
        const item = batch.find((entry) => entry.participantId === subscription.participantId && entry.publicationId === subscription.publicationId);
        if (!item || subscription.channelId === undefined) continue;
        const channel = pc.createDataChannel(item.name, { negotiated: true, id: subscription.channelId, ...policyOf(item.delivery) });
        channel.binaryType = "arraybuffer";
        const remote: RemoteData = { name: item.name, participantId: item.participantId, publicationId: item.publicationId, channel, last: null };
        channel.addEventListener("message", (event) => this.onData(remote, event.data));
        channel.addEventListener("open", () => {
          if (this.remoteData.get(mediaKey(remote.participantId, remote.publicationId)) === remote) {
            this.channels.get(remote.name)?.setPeer(remote.participantId, true);
          }
        });
        this.remoteData.set(mediaKey(item.participantId, item.publicationId), remote);
      }
    }
  }

  private async reconcileMedia(wanted: Map<string, WantedMedia>) {
    const stale = [...this.remoteMedia].filter(([key]) => !wanted.has(key));
    const missing = [...wanted].filter(([key]) => !this.remoteMedia.has(key)).map(([, item]) => item);
    const moves: Array<{ from: string; receiver: RemoteMedia; to: WantedMedia }> = [];
    for (const to of [...missing]) {
      const index = stale.findIndex(([, receiver]) => receiver.kind === to.kind);
      const found = index >= 0 ? stale.splice(index, 1)[0] : undefined;
      if (!found) continue;
      moves.push({ from: found[0], receiver: found[1], to });
      missing.splice(missing.indexOf(to), 1);
    }
    if (moves.length) {
      const moved = await this.retarget(moves.map(({ receiver, to }) => ({ ...to, mid: receiver.mid })));
      for (const { from, receiver, to } of moves) {
        if (moved.has(receiver.mid)) {
          this.remoteMedia.delete(from);
          this.remoteMedia.set(mediaKey(to.participantId, to.publicationId), { ...to, mid: receiver.mid, track: receiver.track });
          this.mediaByMid.set(receiver.mid, mediaKey(to.participantId, to.publicationId));
        } else {
          stale.push([from, receiver]);
          missing.push(to);
        }
      }
      if (moved.size) this.notifyTracks();
    }
    await this.unsubscribeMedia(stale);
    await this.subscribeMedia(missing);
  }

  private async retarget(items: Array<WantedMedia & { mid: string }>): Promise<Set<string>> {
    try {
      const result = await this.request<AppRtcMediaUpdateResponse>("PATCH", `/${this.sessionId}/media`, {
        items: items.map(({ participantId, publicationId, mid, quality }) => ({ participantId, publicationId, mid, ...(quality ? { quality } : {}) })),
      });
      if (result.offer) await this.answerOffer(result.offer);
      return new Set(result.updated.map((item) => item.mid));
    } catch (error) {
      if (error instanceof ConnectionReplacedError || isSessionLost(error)) throw error;
      return new Set();
    }
  }

  private async setQuality(key: string, quality: AppRtcQuality) {
    await this.enqueue(async () => {
      const item = this.remoteMedia.get(key);
      if (!item || item.quality === undefined || item.quality === quality) return;
      const moved = await this.retarget([{ ...item, quality }]);
      if (moved.has(item.mid)) {
        item.quality = quality;
        this.notifyTracks();
      }
    }).catch((error) => {
      if (error instanceof ConnectionReplacedError) return;
      throw toAppRtcError(error);
    });
  }

  private async unsubscribeMedia(stale: Array<[string, RemoteMedia]>) {
    if (stale.length === 0) return;
    const pc = this.requirePc();
    for (const [, item] of stale) {
      pc.getTransceivers().find((transceiver) => transceiver.mid === item.mid)?.stop();
      item.track = null;
    }
    this.notifyTracks();
    await this.offerExchange(pc, (offer) =>
      this.request<AppRtcUnsubscribeResponse>("POST", `/${this.sessionId}/unsubscribe`, {
        items: stale.map(([, item]) => ({ participantId: item.participantId, publicationId: item.publicationId })),
        offer,
      }),
    );
    for (const [key, item] of stale) {
      this.remoteMedia.delete(key);
      this.mediaByMid.delete(item.mid);
    }
  }

  private async subscribeMedia(missing: WantedMedia[]) {
    if (missing.length === 0) return;
    const result = await this.request<AppRtcSubscribeResponse>("POST", `/${this.sessionId}/subscribe`, {
      kind: "media",
      items: missing.map(({ participantId, publicationId, quality }) => ({ participantId, publicationId, ...(quality ? { quality } : {}) })),
    });
    for (const subscription of result.subscriptions) {
      const item = missing.find((entry) => entry.participantId === subscription.participantId && entry.publicationId === subscription.publicationId);
      if (!item || !subscription.mid) continue;
      const key = mediaKey(item.participantId, item.publicationId);
      this.remoteMedia.set(key, { ...item, mid: subscription.mid, track: null });
      this.mediaByMid.set(subscription.mid, key);
    }
    if (!result.offer) return;
    try {
      await this.answerOffer(result.offer);
    } catch (error) {
      if (!(error instanceof ConnectionReplacedError)) this.reconnect();
      throw error;
    }
  }

  private async answerOffer(offer: SessionDescription) {
    const pc = this.requirePc();
    await pc.setRemoteDescription(offer);
    await pc.setLocalDescription(await pc.createAnswer());
    await waitForIceGathering(pc, GATHER_TIMEOUT_MS);
    const answer = pc.localDescription;
    if (!answer) throw new Error("the browser produced no answer");
    await this.request("PUT", `/${this.sessionId}`, { answer: { type: "answer", sdp: answer.sdp } });
  }

  private async localOffer(pc: RTCPeerConnection): Promise<SessionDescription> {
    await pc.setLocalDescription(await pc.createOffer());
    await waitForIceGathering(pc, GATHER_TIMEOUT_MS);
    const offer = pc.localDescription;
    if (!offer) throw new Error("the browser produced no offer");
    return { type: "offer", sdp: offer.sdp };
  }

  // Drops responses that arrive after their connection was replaced.
  private async request<T = unknown>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    const generation = this.generation;
    const settled = await this.send<T>(method, path, body).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    if (generation !== this.generation) throw new ConnectionReplacedError();
    if ("error" in settled) throw settled.error;
    return settled.value;
  }

  private send<T = unknown>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    const url = `/api/apps/${encodeURIComponent(this.host.appId)}/realtime/rooms/${encodeURIComponent(this.host.roomId)}/rtc${path}`;
    return this.host.transport.request<T>(url, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  }

  private requirePc() {
    if (!this.pc || !this.sessionId) throw new ConnectionReplacedError();
    return this.pc;
  }

  private onData(remote: RemoteData, raw: unknown) {
    if (!(raw instanceof ArrayBuffer)) return;
    const frame = decodeAppRtcFrame(raw);
    if (!frame) return;
    const channel = this.channels.get(remote.name);
    if (!channel?.isOpen) return;
    if (channel.delivery === "latest") {
      if (!isNewerSequence(frame.sequence, remote.last)) return;
      remote.last = frame.sequence;
    }
    channel.deliver(remote.participantId, frame.data);
  }

  private onTrack(event: RTCTrackEvent) {
    const mid = event.transceiver.mid;
    const key = mid ? this.mediaByMid.get(mid) : undefined;
    const item = key ? this.remoteMedia.get(key) : undefined;
    if (!item || !mid) return;
    item.track = event.track;
    event.track.addEventListener("ended", () => {
      const current = this.mediaByMid.get(mid);
      const owner = current ? this.remoteMedia.get(current) : undefined;
      if (owner?.track === event.track) {
        owner.track = null;
        this.notifyTracks();
      }
    });
    this.notifyTracks();
  }

  private notifyTracks() {
    const tracks = this.tracks;
    for (const handler of this.trackHandlers) handler(tracks);
  }

  private setState(state: AppRtcState) {
    if (this._state === state) return;
    this._state = state;
    for (const handler of this.stateHandlers) handler(state);
  }
}
