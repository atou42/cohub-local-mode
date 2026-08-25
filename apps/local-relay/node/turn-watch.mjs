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

export function serializeReplacements(replacements) {
  if (replacements instanceof Map) return [...replacements];
  if (Array.isArray(replacements)) return replacements;
  return [];
}

export function emptyWatchState() {
  return { watches: [], pendingEvents: [] };
}

export function normalizeWatchState(value) {
  const watches = Array.isArray(value?.watches)
    ? value.watches.filter(
        (item) =>
          item &&
          typeof item.eventId === "string" &&
          typeof item.spaceId === "string" &&
          typeof item.sessionId === "string" &&
          typeof item.turnId === "string",
      )
    : [];
  const pendingEvents = Array.isArray(value?.pendingEvents)
    ? value.pendingEvents.filter((item) => item && typeof item.id === "string")
    : [];
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
} = {}) {
  const path = watchStatePath(dataDir);
  let state = emptyWatchState();
  let persistChain = Promise.resolve();
  const controllers = new Map();
  const running = new Set();
  let stopped = false;

  function persist() {
    persistChain = persistChain
      .catch(() => undefined)
      .then(() => atomicWriteJson(path, state))
      .catch((error) => {
        if (error?.code === "ENOENT" && stopped) return;
        console.error(
          `[relay-node] failed to persist turn watches: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    return persistChain;
  }

  async function emitEvent(event) {
    if (!state.pendingEvents.some((item) => item.id === event.id)) {
      state.pendingEvents.push(event);
      await persist();
    }
    onEvent?.(event);
  }

  function removeWatch(eventId) {
    state.watches = state.watches.filter((item) => item.eventId !== eventId);
    return persist();
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
          await emitEvent(
            createTurnEvent({
              eventId: watch.eventId,
              spaceId: watch.spaceId,
              sessionId: watch.sessionId,
              turnId: watch.turnId,
              turn: null,
              truncated: true,
              completedAt: new Date(now()).toISOString(),
            }),
          );
          await removeWatch(watch.eventId);
          return;
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
        const body = await readLimitedResponseBody(response, maxResponseBytes);
        let current;
        try {
          current = JSON.parse(body);
        } catch {
          await delay(
            pollIntervalMs(now() - originMs, { fastWindowMs, fastMs, slowMs }),
            controller.signal,
          );
          continue;
        }
        if (TERMINAL_TURN_STATUSES.has(current?.turn?.status)) {
          try {
            await finishWatch(watch, current, controller.signal);
            return;
          } catch (error) {
            if (controller.signal.aborted || error?.name === "AbortError") return;
            console.error(
              `[relay-node] failed to finish turn watch ${watch.eventId}: ${error instanceof Error ? error.message : String(error)}`,
            );
            await delay(
              pollIntervalMs(now() - originMs, { fastWindowMs, fastMs, slowMs }),
              controller.signal,
            );
            continue;
          }
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
        console.error(
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
      try {
        state = await loadWatchState(path);
      } catch (error) {
        console.error(
          `[relay-node] failed to load turn watch state, starting empty: ${error instanceof Error ? error.message : String(error)}`,
        );
        state = emptyWatchState();
      }
      for (const watch of state.watches) void runWatch(watch);
    },
    async watch(record) {
      const stored = {
        eventId: record.eventId,
        spaceId: record.spaceId,
        sessionId: record.sessionId,
        turnId: record.turnId,
        responseReplacements: serializeReplacements(record.responseReplacements),
        nodeId: record.nodeId ?? nodeId,
        startedAt: record.startedAt ?? new Date(now()).toISOString(),
      };
      if (!state.watches.some((item) => item.eventId === stored.eventId)) {
        state.watches.push(stored);
        await persist();
      }
      void runWatch(stored);
    },
    async ack(eventId) {
      const before = state.pendingEvents.length;
      state.pendingEvents = state.pendingEvents.filter((item) => item.id !== eventId);
      if (state.pendingEvents.length !== before) await persist();
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
