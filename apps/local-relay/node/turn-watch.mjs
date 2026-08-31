import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import {
  delay as defaultDelay,
  readLimitedResponseBody,
  relayReturnedArtifacts,
  resolveLocalAccessToken,
  restoreRelayAttachmentUris,
  TERMINAL_TURN_STATUSES,
} from "./core.mjs";

export const TURN_PAYLOAD_MAX_BYTES = 262_144;
export const WATCH_FAST_WINDOW_MS = 60_000;
export const WATCH_POLL_FAST_MS = 1_000;
export const WATCH_POLL_SLOW_MS = 5_000;
export const WATCH_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const WATCH_STATE_FILENAME = "relay-turn-watches.json";
export const RELAY_LIFECYCLE_STATUSES = new Set([
  "queued",
  "running",
  "abort_requested",
  "completed",
  "failed",
  "interrupted",
  "merged",
  "cancelled",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVITY_DISPLAY_NAME_MAX_SCALARS = 255;
const ACTIVITY_DISPLAY_NAME_MAX_BYTES = 1_020;

export function watchStatePath(dataDir) {
  return join(dataDir, WATCH_STATE_FILENAME);
}

export function pollIntervalMs(
  elapsedMs,
  {
    fastWindowMs = WATCH_FAST_WINDOW_MS,
    fastMs = WATCH_POLL_FAST_MS,
    slowMs = WATCH_POLL_SLOW_MS,
  } = {},
) {
  return elapsedMs < fastWindowMs ? fastMs : slowMs;
}

export function isWatchTimedOut(elapsedMs, timeoutMs = WATCH_TIMEOUT_MS) {
  return elapsedMs >= timeoutMs;
}

export function truncateTurnPayload(payload, maxBytes = TURN_PAYLOAD_MAX_BYTES) {
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, "utf8") <= maxBytes) {
    return { turn: payload, truncated: false };
  }
  return { turn: null, truncated: true };
}

export function createTurnEvent({
  eventId,
  spaceId,
  sessionId,
  turnId,
  turn,
  truncated,
  completedAt,
}) {
  return {
    id: eventId,
    kind: "turn.completed",
    spaceId,
    sessionId,
    turnId,
    completedAt,
    turn,
    truncated,
  };
}

export function createTurnLifecycleEvent({
  eventId = randomUUID(),
  nodeId,
  spaceId,
  sessionId,
  turnId,
  status,
  observedAt,
  spaceName,
  sessionTitle,
}) {
  if (!RELAY_LIFECYCLE_STATUSES.has(status)) {
    throw new Error(`Unsupported turn lifecycle status: ${status}`);
  }
  return {
    id: eventId,
    kind: "turn.lifecycle",
    origin: "local",
    nodeId,
    spaceId,
    sessionId,
    turnId,
    status,
    observedAt,
    spaceName,
    sessionTitle,
  };
}

export function serializeReplacements(replacements) {
  if (replacements instanceof Map) return [...replacements];
  if (Array.isArray(replacements)) return replacements;
  return [];
}

export function emptyWatchState() {
  return { watches: [], pendingEvents: [] };
}

function invalidWatchState(path, message) {
  throw new TypeError(`Invalid turn watch state at ${path}: ${message}`);
}

function requireRecord(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidWatchState(path, "must be an object");
  }
  return value;
}

function requireString(value, path, { uuid = false, maxLength } = {}) {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalidWatchState(path, "must be a non-empty string");
  }
  if (maxLength !== undefined && value.length > maxLength) {
    invalidWatchState(path, `must not exceed ${maxLength} characters`);
  }
  if (uuid && !UUID_PATTERN.test(value)) {
    invalidWatchState(path, "must be a UUID");
  }
  return value;
}

function requireTimestamp(value, path) {
  requireString(value, path, { maxLength: 64 });
  if (!Number.isFinite(Date.parse(value))) {
    invalidWatchState(path, "must be an ISO timestamp");
  }
  return value;
}

function normalizeActivityDisplayName(value, path, maxBytes) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    invalidWatchState(path, "must be null or a string");
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    invalidWatchState(path, "must not be empty");
  }
  const scalars = [...normalized];
  const hasUnsupportedCharacter = scalars.some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    );
  });
  if (hasUnsupportedCharacter) {
    invalidWatchState(path, "must not contain control characters");
  }
  if (scalars.length > ACTIVITY_DISPLAY_NAME_MAX_SCALARS) {
    invalidWatchState(
      path,
      `must not exceed ${ACTIVITY_DISPLAY_NAME_MAX_SCALARS} Unicode scalars`,
    );
  }
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) {
    invalidWatchState(path, `must not exceed ${maxBytes} UTF-8 bytes`);
  }
  return normalized;
}

function parseRemoteActivityDisplayName(value, maxBytes) {
  try {
    return normalizeActivityDisplayName(value, "remote display name", maxBytes);
  } catch {
    return null;
  }
}

function normalizeReplacement(value, path) {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    typeof value[1] !== "string"
  ) {
    invalidWatchState(path, "must be a two-string tuple");
  }
  return [value[0], value[1]];
}

function normalizeWatch(value, path) {
  const watch = requireRecord(value, path);
  const eventId = requireString(watch.eventId, `${path}.eventId`, { uuid: true });
  const spaceId = requireString(watch.spaceId, `${path}.spaceId`, { uuid: true });
  const sessionId = requireString(watch.sessionId, `${path}.sessionId`, { uuid: true });
  const turnId = requireString(watch.turnId, `${path}.turnId`, { uuid: true });
  const nodeId = requireString(watch.nodeId, `${path}.nodeId`, { maxLength: 100 });
  const startedAt = requireTimestamp(watch.startedAt, `${path}.startedAt`);
  if (!Array.isArray(watch.responseReplacements)) {
    invalidWatchState(`${path}.responseReplacements`, "must be an array");
  }
  const responseReplacements = watch.responseReplacements.map((replacement, index) =>
    normalizeReplacement(replacement, `${path}.responseReplacements[${index}]`),
  );
  const lastStatus = watch.lastStatus ?? null;
  if (lastStatus !== null && !RELAY_LIFECYCLE_STATUSES.has(lastStatus)) {
    invalidWatchState(`${path}.lastStatus`, "must be null or an authoritative lifecycle status");
  }
  const lastObservedAt = watch.lastObservedAt ?? null;
  if (lastObservedAt !== null) {
    requireTimestamp(lastObservedAt, `${path}.lastObservedAt`);
  }
  const spaceName = normalizeActivityDisplayName(
    watch.spaceName,
    `${path}.spaceName`,
    ACTIVITY_DISPLAY_NAME_MAX_BYTES,
  );
  const sessionTitle = normalizeActivityDisplayName(
    watch.sessionTitle,
    `${path}.sessionTitle`,
    ACTIVITY_DISPLAY_NAME_MAX_BYTES,
  );
  return {
    eventId,
    spaceId,
    sessionId,
    turnId,
    responseReplacements,
    nodeId,
    startedAt,
    lastStatus,
    lastObservedAt,
    spaceName,
    sessionTitle,
  };
}

function normalizePendingEvent(value, path) {
  const event = requireRecord(value, path);
  const id = requireString(event.id, `${path}.id`, { uuid: true });
  const spaceId = requireString(event.spaceId, `${path}.spaceId`, { uuid: true });
  const sessionId = requireString(event.sessionId, `${path}.sessionId`, { uuid: true });
  const turnId = requireString(event.turnId, `${path}.turnId`, { uuid: true });
  if (event.kind === "turn.lifecycle") {
    // This state file was local-only before lifecycle events gained an origin.
    // Migrate that one known shape; an explicit non-local value is corruption.
    const origin = event.origin === undefined ? "local" : event.origin;
    if (origin !== "local") {
      invalidWatchState(`${path}.origin`, "must be local for the local turn watcher");
    }
    const nodeId = requireString(event.nodeId, `${path}.nodeId`, { maxLength: 100 });
    if (!RELAY_LIFECYCLE_STATUSES.has(event.status)) {
      invalidWatchState(`${path}.status`, "must be an authoritative lifecycle status");
    }
    return {
      id,
      kind: "turn.lifecycle",
      origin,
      nodeId,
      spaceId,
      sessionId,
      turnId,
      status: event.status,
      observedAt: requireTimestamp(event.observedAt, `${path}.observedAt`),
      spaceName: normalizeActivityDisplayName(
        event.spaceName,
        `${path}.spaceName`,
        ACTIVITY_DISPLAY_NAME_MAX_BYTES,
      ),
      sessionTitle: normalizeActivityDisplayName(
        event.sessionTitle,
        `${path}.sessionTitle`,
        ACTIVITY_DISPLAY_NAME_MAX_BYTES,
      ),
    };
  }
  if (event.kind !== "turn.completed") {
    invalidWatchState(`${path}.kind`, "must be turn.completed or turn.lifecycle");
  }
  if (typeof event.truncated !== "boolean") {
    invalidWatchState(`${path}.truncated`, "must be a boolean");
  }
  if (
    event.turn !== null &&
    (typeof event.turn !== "object" || Array.isArray(event.turn))
  ) {
    invalidWatchState(`${path}.turn`, "must be an object or null");
  }
  if (event.truncated && event.turn !== null) {
    invalidWatchState(`${path}.turn`, "must be null when truncated is true");
  }
  if (!event.truncated && event.turn === null) {
    invalidWatchState(`${path}.turn`, "must be an object when truncated is false");
  }
  return {
    id,
    kind: "turn.completed",
    spaceId,
    sessionId,
    turnId,
    completedAt: requireTimestamp(event.completedAt, `${path}.completedAt`),
    turn: event.turn,
    truncated: event.truncated,
  };
}

export function normalizeWatchState(value) {
  const source = requireRecord(value, "state");
  if (!Array.isArray(source.watches)) {
    invalidWatchState("state.watches", "must be an array");
  }
  if (!Array.isArray(source.pendingEvents)) {
    invalidWatchState("state.pendingEvents", "must be an array");
  }
  const watches = source.watches.map((watch, index) =>
    normalizeWatch(watch, `state.watches[${index}]`),
  );
  const pendingEvents = source.pendingEvents.map((event, index) =>
    normalizePendingEvent(event, `state.pendingEvents[${index}]`),
  );
  const duplicateWatch = watches.find(
    (watch, index) => watches.findIndex((item) => item.eventId === watch.eventId) !== index,
  );
  if (duplicateWatch) {
    invalidWatchState("state.watches", `contains duplicate eventId ${duplicateWatch.eventId}`);
  }
  const duplicateEvent = pendingEvents.find(
    (event, index) => pendingEvents.findIndex((item) => item.id === event.id) !== index,
  );
  if (duplicateEvent) {
    invalidWatchState("state.pendingEvents", `contains duplicate id ${duplicateEvent.id}`);
  }
  return { watches, pendingEvents };
}

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

export async function loadWatchState(path) {
  try {
    return normalizeWatchState(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyWatchState();
    throw error;
  }
}

export function createTurnWatcher({
  dataDir,
  localApiOrigin = "http://127.0.0.1:8787",
  spaceStorageRoot,
  relayNodeBaseUrl,
  relayNodeToken,
  maxAttachmentBytes,
  maxResponseBytes = 2 * 1024 * 1024,
  fetcher = fetch,
  now = () => Date.now(),
  delay = defaultDelay,
  timeoutMs = WATCH_TIMEOUT_MS,
  fastWindowMs = WATCH_FAST_WINDOW_MS,
  fastMs = WATCH_POLL_FAST_MS,
  slowMs = WATCH_POLL_SLOW_MS,
  onEvent,
  nodeId,
  persistState = atomicWriteJson,
  logError = console.error,
} = {}) {
  const path = watchStatePath(dataDir);
  let state = emptyWatchState();
  let persistChain = Promise.resolve();
  const controllers = new Map();
  const running = new Set();
  let stopped = false;

  function updateState(update) {
    const operation = persistChain.catch(() => undefined).then(async () => {
      const nextState = update(state);
      if (nextState === state) return false;
      const validatedState = normalizeWatchState(nextState);
      await persistState(path, validatedState);
      state = validatedState;
      return true;
    });
    persistChain = operation;
    return operation;
  }

  async function emitEvent(event) {
    const changed = await updateState((current) =>
      current.pendingEvents.some((item) => item.id === event.id)
        ? current
        : { ...current, pendingEvents: [...current.pendingEvents, event] },
    );
    if (changed) onEvent?.(event);
  }

  async function emitLifecycle(
    watch,
    status,
    observedAt = new Date(now()).toISOString(),
    names = { spaceName: watch.spaceName, sessionTitle: watch.sessionTitle },
  ) {
    if (!RELAY_LIFECYCLE_STATUSES.has(status)) return;
    if (!names.spaceName || !names.sessionTitle) return;
    const event = createTurnLifecycleEvent({
      nodeId: watch.nodeId ?? nodeId,
      spaceId: watch.spaceId,
      sessionId: watch.sessionId,
      turnId: watch.turnId,
      status,
      observedAt,
      spaceName: names.spaceName,
      sessionTitle: names.sessionTitle,
    });
    const changed = await updateState((current) => {
      const stored = current.watches.find((item) => item.eventId === watch.eventId);
      if (
        !stored ||
        (stored.lastStatus === status &&
          stored.spaceName === names.spaceName &&
          stored.sessionTitle === names.sessionTitle)
      ) {
        return current;
      }
      return {
        watches: current.watches.map((item) =>
          item.eventId === watch.eventId
            ? {
                ...item,
                lastStatus: status,
                lastObservedAt: observedAt,
                spaceName: names.spaceName,
                sessionTitle: names.sessionTitle,
              }
            : item,
        ),
        pendingEvents: [...current.pendingEvents, event],
      };
    });
    if (!changed) return;
    watch.lastStatus = status;
    watch.lastObservedAt = observedAt;
    watch.spaceName = names.spaceName;
    watch.sessionTitle = names.sessionTitle;
    onEvent?.(event);
  }

  async function fetchSpaceName(watch, accessToken, signal) {
    let response;
    try {
      response = await fetcher(
        `${localApiOrigin}/api/spaces/${encodeURIComponent(watch.spaceId)}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${accessToken}` },
          cache: "no-store",
          signal,
        },
      );
    } catch {
      if (signal.aborted) throw signal.reason;
      return null;
    }
    if (!response.ok) return null;
    try {
      const payload = JSON.parse(await readLimitedResponseBody(response, maxResponseBytes));
      if (payload?.id !== watch.spaceId) return null;
      return parseRemoteActivityDisplayName(
        payload?.name,
        ACTIVITY_DISPLAY_NAME_MAX_BYTES,
      );
    } catch {
      return null;
    }
  }

  function removeWatch(eventId) {
    return updateState((current) => {
      const watches = current.watches.filter((item) => item.eventId !== eventId);
      return watches.length === current.watches.length ? current : { ...current, watches };
    });
  }

  async function finishWatch(watch, payload, signal) {
    const assembled = JSON.stringify({
      session: payload.session ?? null,
      turn: payload.turn ?? null,
    });
    let nextBody = assembled;
    if (spaceStorageRoot) {
      nextBody = await relayReturnedArtifacts(
        assembled,
        { nodeId: watch.nodeId ?? nodeId },
        {
          fetcher,
          maxAttachmentBytes,
          localAccessToken: await resolveLocalAccessToken(
            fetcher,
            localApiOrigin,
            signal,
          ),
          localApiOrigin,
          relayNodeBaseUrl,
          relayNodeToken,
          signal,
        },
        resolve(spaceStorageRoot, watch.spaceId, "workspace"),
      );
    }
    nextBody = restoreRelayAttachmentUris(
      nextBody,
      new Map(serializeReplacements(watch.responseReplacements)),
    );
    let parsed = null;
    try {
      parsed = JSON.parse(nextBody);
    } catch {
      parsed = null;
    }
    const { turn, truncated } = parsed
      ? truncateTurnPayload(parsed)
      : { turn: null, truncated: true };
    await emitEvent(
      createTurnEvent({
        eventId: watch.eventId,
        spaceId: watch.spaceId,
        sessionId: watch.sessionId,
        turnId: watch.turnId,
        turn,
        truncated,
        completedAt: new Date(now()).toISOString(),
      }),
    );
    await removeWatch(watch.eventId);
  }

  async function runWatch(watch) {
    if (controllers.has(watch.eventId) || stopped) return;
    const task = (async () => {
    const controller = new AbortController();
    controllers.set(watch.eventId, controller);
    const startedAt = Date.parse(watch.startedAt);
    const originMs = Number.isFinite(startedAt) ? startedAt : now();
    try {
      while (!stopped && !controller.signal.aborted) {
        const elapsed = now() - originMs;
        if (isWatchTimedOut(elapsed, timeoutMs)) {
          logError(
            `[relay-node] turn watch ${watch.eventId} timed out without an authoritative terminal turn`,
          );
          try {
            await removeWatch(watch.eventId);
            return;
          } catch (error) {
            if (controller.signal.aborted || error?.name === "AbortError") return;
            logError(
              `[relay-node] failed to persist timed-out turn watch removal ${watch.eventId}: ${error instanceof Error ? error.message : String(error)}`,
            );
            await delay(
              pollIntervalMs(now() - originMs, { fastWindowMs, fastMs, slowMs }),
              controller.signal,
            );
            continue;
          }
        }
        let accessToken;
        try {
          accessToken = await resolveLocalAccessToken(
            fetcher,
            localApiOrigin,
            controller.signal,
          );
        } catch (error) {
          if (controller.signal.aborted || error?.name === "AbortError") return;
          await delay(
            pollIntervalMs(now() - originMs, { fastWindowMs, fastMs, slowMs }),
            controller.signal,
          );
          continue;
        }
        let response;
        try {
          response = await fetcher(
            `${localApiOrigin}/api/sessions/${encodeURIComponent(watch.sessionId)}/turns/${encodeURIComponent(watch.turnId)}`,
            {
              method: "GET",
              headers: { authorization: `Bearer ${accessToken}` },
              cache: "no-store",
              signal: controller.signal,
            },
          );
        } catch {
          if (controller.signal.aborted) return;
          await delay(
            pollIntervalMs(now() - originMs, { fastWindowMs, fastMs, slowMs }),
            controller.signal,
          );
          continue;
        }
        if (!response.ok) {
          await delay(
            pollIntervalMs(now() - originMs, { fastWindowMs, fastMs, slowMs }),
            controller.signal,
          );
          continue;
        }
        let current;
        try {
          current = JSON.parse(await readLimitedResponseBody(response, maxResponseBytes));
        } catch {
          await delay(
            pollIntervalMs(now() - originMs, { fastWindowMs, fastMs, slowMs }),
            controller.signal,
          );
          continue;
        }
        if (current?.session?.id !== watch.sessionId || current?.turn?.id !== watch.turnId) {
          await delay(
            pollIntervalMs(now() - originMs, { fastWindowMs, fastMs, slowMs }),
            controller.signal,
          );
          continue;
        }
        let spaceName = watch.spaceName;
        let sessionTitle = watch.sessionTitle;
        if (!spaceName || !sessionTitle) {
          sessionTitle = parseRemoteActivityDisplayName(
            current?.session?.title,
            ACTIVITY_DISPLAY_NAME_MAX_BYTES,
          );
          spaceName = sessionTitle
            ? await fetchSpaceName(watch, accessToken, controller.signal)
            : null;
          if (!spaceName || !sessionTitle) {
            await delay(
              pollIntervalMs(now() - originMs, { fastWindowMs, fastMs, slowMs }),
              controller.signal,
            );
            continue;
          }
        }
        const currentStatus = current?.turn?.status;
        try {
          if (
            RELAY_LIFECYCLE_STATUSES.has(currentStatus) &&
            currentStatus !== watch.lastStatus
          ) {
            const sourceUpdatedAt = current?.turn?.updatedAt;
            const sourceUpdatedAtMs =
              typeof sourceUpdatedAt === "string" ? Date.parse(sourceUpdatedAt) : Number.NaN;
            const lastObservedAtMs = watch.lastObservedAt
              ? Date.parse(watch.lastObservedAt)
              : Number.NEGATIVE_INFINITY;
            if (
              !Number.isFinite(sourceUpdatedAtMs) ||
              sourceUpdatedAtMs <= lastObservedAtMs
            ) {
              logError(
                `[relay-node] turn watch ${watch.eventId} ignored lifecycle status ${currentStatus}: turn.updatedAt is missing, invalid, or non-monotonic`,
              );
              await delay(
                pollIntervalMs(now() - originMs, { fastWindowMs, fastMs, slowMs }),
                controller.signal,
              );
              continue;
            }
            const observedAt = new Date(sourceUpdatedAtMs).toISOString();
            await emitLifecycle(watch, currentStatus, observedAt, {
              spaceName,
              sessionTitle,
            });
          }
          if (TERMINAL_TURN_STATUSES.has(current?.turn?.status)) {
            await finishWatch(watch, current, controller.signal);
            return;
          }
        } catch (error) {
          if (controller.signal.aborted || error?.name === "AbortError") return;
          logError(
            `[relay-node] failed to advance turn watch ${watch.eventId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          await delay(
            pollIntervalMs(now() - originMs, { fastWindowMs, fastMs, slowMs }),
            controller.signal,
          );
          continue;
        }
        await delay(
          pollIntervalMs(now() - originMs, { fastWindowMs, fastMs, slowMs }),
          controller.signal,
        );
      }
    } catch (error) {
      // Never let a watch crash escape into an unhandled rejection that would
      // take the whole node process down; log and drop this watch loop.
      if (error?.name !== "AbortError") {
        logError(
          `[relay-node] turn watch ${watch.eventId} crashed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      controllers.delete(watch.eventId);
    }
    })();
    running.add(task);
    try {
      await task;
    } finally {
      running.delete(task);
    }
  }

  return {
    async start() {
      state = await loadWatchState(path);
      for (const watch of state.watches) void runWatch(watch);
    },
    async watch(record) {
      let stored = {
        eventId: record.eventId,
        spaceId: record.spaceId,
        sessionId: record.sessionId,
        turnId: record.turnId,
        responseReplacements: serializeReplacements(record.responseReplacements),
        nodeId: record.nodeId ?? nodeId,
        startedAt: record.startedAt ?? new Date(now()).toISOString(),
        lastStatus: null,
        lastObservedAt: null,
        spaceName: record.spaceName ?? null,
        sessionTitle: record.sessionTitle ?? null,
      };
      await updateState((current) => {
        const existing = current.watches.find((item) => item.eventId === stored.eventId);
        if (existing) {
          stored = existing;
          return current;
        }
        return { ...current, watches: [...current.watches, stored] };
      });
      void runWatch(stored);
    },
    async ack(eventId) {
      await updateState((current) => {
        const pendingEvents = current.pendingEvents.filter((item) => item.id !== eventId);
        return pendingEvents.length === current.pendingEvents.length
          ? current
          : { ...current, pendingEvents };
      });
    },
    pendingEvents() {
      return [...state.pendingEvents];
    },
    watches() {
      return [...state.watches];
    },
    flushPending() {
      for (const event of state.pendingEvents) onEvent?.(event);
    },
    async stop() {
      stopped = true;
      for (const controller of controllers.values()) {
        controller.abort(new DOMException("Turn watcher stopped", "AbortError"));
      }
      controllers.clear();
      await Promise.allSettled(running);
      await persistChain.catch(() => undefined);
    },
  };
}
