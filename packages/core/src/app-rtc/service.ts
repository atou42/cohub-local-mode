import { randomBytes, randomUUID } from "node:crypto";
import {
  APP_RTC_LIMITS,
  type AppRtcCloseReason,
  type AppRtcDelivery,
  type AppRtcOpenResponse,
  type AppRtcPublication,
  type AppRtcPublicationKind,
  type AppRtcMediaUpdateResponse,
  type AppRtcPublishRequest,
  type AppRtcPublishResponse,
  type AppRtcQuality,
  type AppRtcSubscribeResponse,
  type AppRtcSubscriptionRef,
  type AppRtcUnpublishResponse,
  type AppRtcUnsubscribeResponse,
  type RtcIceServer,
  type SessionDescription,
  appRtcQualityRid,
} from "@cohub/protocol/rtc";
import { type SfuClient, type SfuDataChannelPolicy, SfuError } from "./sfu.js";
import {
  type AppRtcStore,
  type LocalResource,
  localField,
  MemberRtcError,
  type MemberRtcStatus,
  type RemoteResource,
  remoteField,
  type SessionRecord,
} from "./store.js";

export type AppRtcErrorCode =
  | "RTC_UNAVAILABLE"
  | "RTC_SESSION_NOT_FOUND"
  | "RTC_FORBIDDEN"
  | "RTC_STALE"
  | "RTC_LIMIT_EXCEEDED"
  | "RTC_NAME_TAKEN"
  | "RTC_RATE_LIMITED"
  | "RTC_UPSTREAM"
  | "ROOM_NOT_FOUND"
  | "ROOM_EXPIRED";

const ERROR_STATUS: Record<AppRtcErrorCode, number> = {
  RTC_UNAVAILABLE: 503,
  RTC_SESSION_NOT_FOUND: 404,
  RTC_FORBIDDEN: 403,
  RTC_STALE: 409,
  RTC_LIMIT_EXCEEDED: 409,
  RTC_NAME_TAKEN: 409,
  RTC_RATE_LIMITED: 429,
  RTC_UPSTREAM: 502,
  ROOM_NOT_FOUND: 404,
  ROOM_EXPIRED: 410,
};

export class AppRtcError extends Error {
  readonly status: number;
  constructor(readonly code: AppRtcErrorCode, message: string) {
    super(message);
    this.name = "AppRtcError";
    this.status = ERROR_STATUS[code];
  }
}

const MEMBER_ERRORS: Record<MemberRtcStatus, [AppRtcErrorCode, string]> = {
  room_not_found: ["ROOM_NOT_FOUND", "room not found"],
  room_expired: ["ROOM_EXPIRED", "room expired"],
  not_member: ["RTC_STALE", "join the room before using RTC"],
  forbidden: ["RTC_FORBIDDEN", "the room seat belongs to another viewer"],
  stale: ["RTC_STALE", "this RTC session was replaced; reconnect"],
  limit: ["RTC_LIMIT_EXCEEDED", "publication limit reached"],
  name_taken: ["RTC_NAME_TAKEN", "a publication with this name already exists"],
};

const toAppRtcError = (error: unknown): unknown => {
  if (error instanceof MemberRtcError) {
    const [code, message] = MEMBER_ERRORS[error.status];
    return new AppRtcError(code, message);
  }
  if (error instanceof SfuError) return new AppRtcError("RTC_UPSTREAM", "the media relay rejected the request");
  return error;
};

async function mapped<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toAppRtcError(error);
  }
}

export const deliveryPolicy = (delivery: AppRtcDelivery | undefined): SfuDataChannelPolicy =>
  delivery === "latest" ? { ordered: false, maxRetransmits: 0 } : {};

const publicationId = () => randomBytes(6).toString("base64url");

const simulcastPreference = (publication: AppRtcPublication, quality: AppRtcQuality | undefined) =>
  publication.simulcast ? { preferredRid: appRtcQualityRid(quality ?? "high") } : undefined;

const byName = <T extends { errorCode?: string }>(items: T[] | undefined, name: (item: T) => string | undefined) => {
  const found = new Map<string, T>();
  for (const item of items ?? []) {
    const key = name(item);
    if (key && !item.errorCode) found.set(key, item);
  }
  return found;
};

const MEMBER_LIMITS = { data: APP_RTC_LIMITS.channelsPerMember, media: APP_RTC_LIMITS.tracksPerMember };
const SUBSCRIPTION_LIMITS = { data: APP_RTC_LIMITS.dataSubscriptions, media: APP_RTC_LIMITS.mediaSubscriptions };

export type AppRtcLogger = {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
};

export type AppRtcCaller = { appId: string; userUuid: string };

const recordWithout = (next: SessionRecord, previous: SessionRecord): SessionRecord => ({
  ...next,
  local: new Map([...next.local].filter(([key]) => !previous.local.has(key))),
  remote: new Map([...next.remote].filter(([key]) => !previous.remote.has(key))),
});

const countKinds = (kinds: AppRtcPublicationKind[]) => {
  const counts: Partial<Record<AppRtcPublicationKind, number>> = {};
  for (const kind of kinds) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
};

const negate = (counts: Partial<Record<AppRtcPublicationKind, number>>) =>
  Object.fromEntries(Object.entries(counts).map(([kind, count]) => [kind, -(count ?? 0)]));

export class AppRtcService {
  constructor(
    private readonly deps: {
      store: AppRtcStore;
      sfu: SfuClient | null;
      logger: AppRtcLogger;
      iceServers?: (userUuid: string) => Promise<RtcIceServer[]>;
    },
  ) {}

  get available() {
    return this.deps.sfu !== null;
  }

  private requireSfu() {
    if (!this.deps.sfu) throw new AppRtcError("RTC_UNAVAILABLE", "RTC is not configured on this server");
    return this.deps.sfu;
  }

  private async limitRate(scope: string, limit: number = APP_RTC_LIMITS.operationsPerSecond) {
    if (!(await this.deps.store.consumeRate(scope, limit))) {
      throw new AppRtcError("RTC_RATE_LIMITED", "too many RTC requests");
    }
  }

  private async authorize(caller: AppRtcCaller, roomId: string, sessionId: string) {
    const session = await this.deps.store.getSession(sessionId);
    if (!session || session.roomId !== roomId || session.appId !== caller.appId || session.userUuid !== caller.userUuid) {
      throw new AppRtcError("RTC_SESSION_NOT_FOUND", "RTC session not found");
    }
    await this.limitRate(sessionId);
    await mapped(() => this.deps.store.assertOwner(roomId, session.participantId, sessionId));
    return session;
  }

  async open(input: {
    caller: AppRtcCaller;
    spaceId: string;
    room: { id: string; expiresAtMs: number };
    participantId: string;
    userKey: string;
  }): Promise<AppRtcOpenResponse> {
    const sfu = this.requireSfu();
    const { store } = this.deps;
    await this.limitRate(`open:${input.room.id}:${input.caller.userUuid}`, APP_RTC_LIMITS.opensPerSecond);
    await mapped(() => store.assertSeat(input.room.id, input.participantId, input.userKey));
    const [sessionId, iceServers] = await mapped(() =>
      Promise.all([sfu.createSession(), this.deps.iceServers?.(input.caller.userUuid) ?? []]),
    );
    const { sessionDescription: offer } = await mapped(() => sfu.establishDataChannels(sessionId));
    if (offer?.type !== "offer") throw new AppRtcError("RTC_UPSTREAM", "the media relay returned no offer");

    await store.createSession({
      sessionId,
      appId: input.caller.appId,
      roomId: input.room.id,
      participantId: input.participantId,
      userUuid: input.caller.userUuid,
      spaceId: input.spaceId,
      roomExpiresAtMs: input.room.expiresAtMs,
    });
    let previousSessionId: string | null;
    try {
      ({ previousSessionId } = await mapped(() =>
        store.changeMember({
          roomId: input.room.id,
          participantId: input.participantId,
          sessionId,
          change: { mode: "claim", userKey: input.userKey },
          eventId: randomUUID(),
        }),
      ));
    } catch (error) {
      await store.takeSession(sessionId).catch(() => undefined);
      throw error;
    }
    this.deps.logger.info("[AppRTC] session opened", {
      appId: input.caller.appId,
      spaceId: input.spaceId,
      roomId: input.room.id,
      sessionId,
      participantId: input.participantId,
      userId: input.caller.userUuid,
    });
    if (previousSessionId) await this.close(previousSessionId, "replaced").catch(() => undefined);
    return { sessionId, offer, iceServers };
  }

  async check(input: { caller: AppRtcCaller; roomId: string; sessionId: string }) {
    await this.authorize(input.caller, input.roomId, input.sessionId);
  }

  async answer(input: { caller: AppRtcCaller; roomId: string; sessionId: string; answer: SessionDescription }) {
    await this.authorize(input.caller, input.roomId, input.sessionId);
    await mapped(() => this.requireSfu().renegotiate(input.sessionId, input.answer));
  }

  async publish(input: {
    caller: AppRtcCaller;
    roomId: string;
    sessionId: string;
    request: AppRtcPublishRequest;
  }): Promise<AppRtcPublishResponse> {
    const session = await this.authorize(input.caller, input.roomId, input.sessionId);
    const sfu = this.requireSfu();
    const { request } = input;
    const publications: AppRtcPublication[] = [];
    const resources = new Map<string, LocalResource>();
    let answer: SessionDescription | undefined;

    if ("channels" in request) {
      for (const channel of request.channels) {
        publications.push({ id: publicationId(), name: channel.name, kind: "data", delivery: channel.delivery });
      }
      const { dataChannels } = await mapped(() =>
        sfu.publishDataChannels(
          input.sessionId,
          publications.map((publication) => ({ name: publication.id, ...deliveryPolicy(publication.delivery) })),
        ),
      );
      const allocated = byName(dataChannels, (item) => item.dataChannelName);
      for (const publication of publications) {
        const result = allocated.get(publication.id);
        if (result && typeof result.id === "number") {
          resources.set(publication.id, { kind: "data", name: publication.name, channelId: result.id });
        }
      }
    } else {
      for (const track of request.tracks) {
        publications.push({
          id: publicationId(),
          name: track.name,
          kind: track.kind,
          ...(track.simulcast && track.kind === "video" ? { simulcast: true } : {}),
        });
      }
      const result = await mapped(() =>
        sfu.publishTracks(
          input.sessionId,
          request.offer,
          request.tracks.map((track, index) => ({ mid: track.mid, trackName: publications[index]?.id ?? "" })),
        ),
      );
      answer = result.sessionDescription;
      const allocated = byName(result.tracks, (item) => item.trackName);
      publications.forEach((publication, index) => {
        if (allocated.has(publication.id)) {
          resources.set(publication.id, { kind: publication.kind, name: publication.name, mid: request.tracks[index]?.mid });
        }
      });
    }

    if (resources.size !== publications.length) {
      await this.releaseLocal(input.sessionId, [...resources.values()]);
      throw new AppRtcError("RTC_UPSTREAM", "the media relay could not publish every item");
    }

    try {
      await mapped(() =>
        this.deps.store.changeMember({
          roomId: input.roomId,
          participantId: session.participantId,
          sessionId: input.sessionId,
          change: { mode: "add", publications, limits: MEMBER_LIMITS },
          eventId: randomUUID(),
        }),
      );
    } catch (error) {
      await this.releaseLocal(input.sessionId, [...resources.values()]);
      throw error;
    }
    await this.deps.store.updateSession(input.sessionId, {
      set: Object.fromEntries([...resources].map(([id, resource]) => [localField(id), JSON.stringify(resource)])),
      publications: countKinds(publications.map((publication) => publication.kind)),
    });

    const channelIds: Record<string, number> = {};
    for (const [id, resource] of resources) if (resource.channelId !== undefined) channelIds[id] = resource.channelId;
    return { publications, ...(Object.keys(channelIds).length ? { channelIds } : {}), ...(answer ? { answer } : {}) };
  }

  async unpublish(input: {
    caller: AppRtcCaller;
    roomId: string;
    sessionId: string;
    ids: string[];
    offer?: SessionDescription;
  }): Promise<AppRtcUnpublishResponse> {
    const session = await this.authorize(input.caller, input.roomId, input.sessionId);
    const owned = input.ids.flatMap((id) => {
      const resource = session.local.get(id);
      return resource ? [{ id, resource }] : [];
    });
    await mapped(() =>
      this.deps.store.changeMember({
        roomId: input.roomId,
        participantId: session.participantId,
        sessionId: input.sessionId,
        change: { mode: "remove", ids: input.ids },
        eventId: randomUUID(),
      }),
    );
    const answer = await this.closeOnRelay(input.sessionId, owned.map(({ resource }) => resource), input.offer);
    await this.deps.store.updateSession(input.sessionId, { del: owned.map(({ id }) => localField(id)) });
    return answer ? { answer } : {};
  }

  async subscribe(input: {
    caller: AppRtcCaller;
    roomId: string;
    sessionId: string;
    kind: "data" | "media";
    items: Array<AppRtcSubscriptionRef & { quality?: AppRtcQuality }>;
  }): Promise<AppRtcSubscribeResponse> {
    const session = await this.authorize(input.caller, input.roomId, input.sessionId);
    const sfu = this.requireSfu();
    const { store } = this.deps;
    let resolved = (
      await mapped(() =>
        store.resolve({
          roomId: input.roomId,
          participantId: session.participantId,
          sessionId: input.sessionId,
          refs: input.items,
        }),
      )
    ).filter(({ participantId, publication }) =>
      (input.kind === "data") === (publication.kind === "data") &&
      !session.remote.has(`${participantId}:${publication.id}`),
    );
    const unique = new Map(resolved.map((item) => [`${item.participantId}:${item.publication.id}`, item]));
    resolved = [...unique.values()];
    if (resolved.length === 0) return { subscriptions: [] };

    const reserved = countKinds(resolved.map(({ publication }) => publication.kind));
    const reservation = await store.updateSession(input.sessionId, { subscriptions: reserved, limits: SUBSCRIPTION_LIMITS });
    if (reservation === "limit") throw new AppRtcError("RTC_LIMIT_EXCEEDED", "subscription limit reached");
    if (reservation === "missing") throw new AppRtcError("RTC_SESSION_NOT_FOUND", "RTC session not found");

    const accepted = new Map<string, RemoteResource & AppRtcSubscriptionRef>();
    let offer: SessionDescription | undefined;
    try {
      if (input.kind === "data") {
        const { dataChannels } = await sfu.subscribeDataChannels(
          input.sessionId,
          resolved.map(({ sessionId, publication }) => ({
            name: publication.id,
            publisherSessionId: sessionId,
            ...deliveryPolicy(publication.delivery),
          })),
        );
        const allocated = byName(dataChannels, (item) => item.sessionId && `${item.sessionId}/${item.dataChannelName}`);
        for (const { participantId, sessionId, publication } of resolved) {
          const result = allocated.get(`${sessionId}/${publication.id}`);
          if (result && typeof result.id === "number") {
            accepted.set(remoteField(participantId, publication.id), { participantId, publicationId: publication.id, kind: "data", channelId: result.id });
          }
        }
      } else {
        const quality = new Map(input.items.map((item) => [`${item.participantId}:${item.publicationId}`, item.quality]));
        const result = await sfu.subscribeTracks(
          input.sessionId,
          resolved.map(({ participantId, sessionId, publication }) => ({
            publisherSessionId: sessionId,
            trackName: publication.id,
            simulcast: simulcastPreference(publication, quality.get(`${participantId}:${publication.id}`)),
          })),
        );
        offer = result.sessionDescription;
        const allocated = byName(result.tracks, (item) => item.sessionId && `${item.sessionId}/${item.trackName}`);
        for (const { participantId, sessionId, publication } of resolved) {
          const item = allocated.get(`${sessionId}/${publication.id}`);
          if (item?.mid) {
            accepted.set(remoteField(participantId, publication.id), { participantId, publicationId: publication.id, kind: publication.kind, mid: item.mid });
          }
        }
      }
    } catch (error) {
      await store.updateSession(input.sessionId, { subscriptions: negate(reserved) });
      throw toAppRtcError(error);
    }

    const refused = negate(reserved);
    for (const item of accepted.values()) refused[item.kind] = (refused[item.kind] ?? 0) + 1;
    const recorded = await store.updateSession(input.sessionId, {
      subscriptions: refused,
      set: Object.fromEntries(
        [...accepted].map(([field, { kind, channelId, mid }]) => [field, JSON.stringify({ kind, channelId, mid })]),
      ),
    });
    if (recorded === "missing") {
      await this.closeOnRelay(input.sessionId, [...accepted.values()]).catch(() => undefined);
      throw new AppRtcError("RTC_SESSION_NOT_FOUND", "RTC session not found");
    }
    return {
      subscriptions: [...accepted.values()].map(({ participantId, publicationId, channelId, mid }) => ({
        participantId,
        publicationId,
        ...(channelId !== undefined ? { channelId } : {}),
        ...(mid !== undefined ? { mid } : {}),
      })),
      ...(offer ? { offer } : {}),
    };
  }

  async updateMedia(input: {
    caller: AppRtcCaller;
    roomId: string;
    sessionId: string;
    items: Array<AppRtcSubscriptionRef & { mid: string; quality?: AppRtcQuality }>;
  }): Promise<AppRtcMediaUpdateResponse> {
    const session = await this.authorize(input.caller, input.roomId, input.sessionId);
    const sfu = this.requireSfu();
    const receivers = new Map<string, { key: string; resource: RemoteResource }>();
    for (const [key, resource] of session.remote) if (resource.mid) receivers.set(resource.mid, { key, resource });
    const resolved = await mapped(() =>
      this.deps.store.resolve({ roomId: input.roomId, participantId: session.participantId, sessionId: input.sessionId, refs: input.items }),
    );
    const targets = new Map(resolved.map((item) => [`${item.participantId}:${item.publication.id}`, item]));
    const claimed = new Set<string>();
    const changes = input.items.flatMap((item) => {
      const receiver = receivers.get(item.mid);
      const key = `${item.participantId}:${item.publicationId}`;
      const target = targets.get(key);
      if (!receiver || !target || target.publication.kind !== receiver.resource.kind || claimed.has(key)) return [];
      if (key !== receiver.key && session.remote.has(key)) return [];
      claimed.add(key);
      return [{ item, receiver, target }];
    });
    if (changes.length === 0) return { updated: [] };

    const result = await mapped(() =>
      sfu.updateTracks(input.sessionId, changes.map(({ item, target }) => ({
        mid: item.mid,
        publisherSessionId: target.sessionId,
        trackName: target.publication.id,
        simulcast: simulcastPreference(target.publication, item.quality),
      }))),
    );
    const accepted = new Set((result.tracks ?? []).flatMap((track) => (track.mid && !track.errorCode ? [track.mid] : [])));
    const applied = changes.filter(({ item }) => accepted.has(item.mid));
    const moved = applied.filter(({ item, receiver }) => `${item.participantId}:${item.publicationId}` !== receiver.key);
    if (moved.length) {
      await this.deps.store.updateSession(input.sessionId, {
        del: moved.map(({ receiver }) => `remote:${receiver.key}`),
        set: Object.fromEntries(moved.map(({ item, receiver }) => [
          remoteField(item.participantId, item.publicationId),
          JSON.stringify({ kind: receiver.resource.kind, mid: item.mid }),
        ])),
      });
    }
    const offer = result.requiresImmediateRenegotiation && result.sessionDescription?.type === "offer" ? result.sessionDescription : undefined;
    return {
      updated: applied.map(({ item }) => ({ participantId: item.participantId, publicationId: item.publicationId, mid: item.mid })),
      ...(offer ? { offer } : {}),
    };
  }

  async unsubscribe(input: {
    caller: AppRtcCaller;
    roomId: string;
    sessionId: string;
    items: AppRtcSubscriptionRef[];
    offer?: SessionDescription;
  }): Promise<AppRtcUnsubscribeResponse> {
    const session = await this.authorize(input.caller, input.roomId, input.sessionId);
    const owned = new Map<string, RemoteResource>();
    for (const { participantId, publicationId } of input.items) {
      const resource = session.remote.get(`${participantId}:${publicationId}`);
      if (resource) owned.set(remoteField(participantId, publicationId), resource);
    }
    if (owned.size === 0) return {};
    const answer = await this.closeOnRelay(input.sessionId, [...owned.values()], input.offer);
    await this.deps.store.updateSession(input.sessionId, {
      release: [...owned].map(([field, resource]) => [field, resource.kind]),
    });
    return answer ? { answer } : {};
  }

  private async closeOnRelay(sessionId: string, resources: Array<LocalResource | RemoteResource>, offer?: SessionDescription) {
    const sfu = this.requireSfu();
    const channelIds = resources.flatMap((resource) => (resource.channelId === undefined ? [] : [resource.channelId]));
    const mids = resources.flatMap((resource) => (resource.mid === undefined ? [] : [resource.mid]));
    if (channelIds.length) await mapped(() => sfu.closeDataChannels(sessionId, channelIds));
    if (!mids.length) return undefined;
    const result = await mapped(() => sfu.closeTracks(sessionId, mids, offer));
    return offer ? result.sessionDescription : undefined;
  }

  async closeOwned(input: { caller: AppRtcCaller; roomId: string; sessionId: string }) {
    const session = await this.deps.store.getSession(input.sessionId);
    if (!session) return;
    if (session.roomId !== input.roomId || session.appId !== input.caller.appId || session.userUuid !== input.caller.userUuid) {
      throw new AppRtcError("RTC_SESSION_NOT_FOUND", "RTC session not found");
    }
    await this.close(input.sessionId, "closed").catch((error) => {
      this.deps.logger.warn("[AppRTC] failed to close session", { sessionId: input.sessionId, error: String(error) });
    });
  }

  async close(sessionId: string, reason: AppRtcCloseReason) {
    const record = await this.deps.store.getSession(sessionId);
    if (!record) {
      await this.deps.store.takeSession(sessionId);
      return;
    }
    await this.deps.store.changeMember({
      roomId: record.roomId,
      participantId: record.participantId,
      sessionId,
      change: { mode: "release" },
      eventId: randomUUID(),
    }).catch(() => undefined);
    // Keep the record until the SFU confirms, so a failed close is retried by the sweeper.
    await this.releaseSfu(sessionId, record);
    const taken = await this.deps.store.takeSession(sessionId);
    if (!taken) return;
    const late = recordWithout(taken, record);
    if (late.local.size || late.remote.size) {
      await this.releaseSfu(sessionId, late).catch((error) => {
        this.deps.logger.warn("[AppRTC] failed to close late resources", { sessionId, error: String(error) });
      });
    }
    this.logClosed(sessionId, taken, reason);
  }

  async sweep(batch = 200): Promise<{ checked: number; closed: number }> {
    const { store } = this.deps;
    let checked = 0;
    let closed = 0;
    for (;;) {
      const due = await store.claimDueSessions(batch);
      checked += due.length;
      for (const sessionId of due) {
        const session = await store.getSession(sessionId);
        if (!session) {
          await store.takeSession(sessionId);
          continue;
        }
        const status = await store.ownerStatus(session.roomId, session.participantId, sessionId);
        if (status === "active") continue;
        try {
          await this.close(sessionId, status === "room_not_found" || status === "room_expired" ? "expired" : "stale");
          closed += 1;
        } catch (error) {
          this.deps.logger.warn("[AppRTC] failed to close session", { sessionId, error: String(error) });
        }
      }
      if (due.length < batch) break;
    }
    return { checked, closed };
  }

  private async releaseLocal(sessionId: string, resources: LocalResource[]) {
    const sfu = this.deps.sfu;
    if (!sfu) return;
    const channelIds = resources.flatMap((resource) => (resource.channelId === undefined ? [] : [resource.channelId]));
    const mids = resources.flatMap((resource) => (resource.mid === undefined ? [] : [resource.mid]));
    if (channelIds.length) await sfu.closeDataChannels(sessionId, channelIds).catch(() => undefined);
    if (mids.length) await sfu.closeTracks(sessionId, mids).catch(() => undefined);
  }

  private async releaseSfu(sessionId: string, record: SessionRecord) {
    const sfu = this.deps.sfu;
    if (!sfu) return;
    const resources = [...record.local.values(), ...record.remote.values()];
    const channelIds = resources.flatMap((resource) => (resource.channelId === undefined ? [] : [resource.channelId]));
    const mids = resources.flatMap((resource) => (resource.mid === undefined ? [] : [resource.mid]));
    const gone = (error: unknown) => {
      if (error instanceof SfuError && (error.status === 404 || error.status === 410)) return;
      throw error;
    };
    if (channelIds.length) await sfu.closeDataChannels(sessionId, channelIds).catch(gone);
    if (mids.length) await sfu.closeTracks(sessionId, mids).catch(gone);
  }

  private logClosed(sessionId: string, record: SessionRecord, reason: AppRtcCloseReason) {
    const seconds = (ms: number) => Math.round(ms / 1000);
    const { publications, subscriptionMs } = record.usage;
    this.deps.logger.info("[AppRTC] session closed", {
      appId: record.appId,
      spaceId: record.spaceId,
      roomId: record.roomId,
      sessionId,
      participantId: record.participantId,
      userId: record.userUuid,
      reason,
      durationMs: record.openedAt ? Math.max(0, Date.now() - record.openedAt) : null,
      published: publications,
      subscriptionSeconds: {
        data: seconds(subscriptionMs.data),
        audio: seconds(subscriptionMs.audio),
        video: seconds(subscriptionMs.video),
      },
    });
  }
}

