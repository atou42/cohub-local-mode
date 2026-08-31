import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import WebSocket from "ws";

export const PULSE_STATE_FILENAME = "relay-pulse-watch.json";
export const PULSE_RECONCILE_INTERVAL_MS = 30_000;
export const PULSE_DISCONNECTED_POLL_MS = 5_000;
export const PULSE_MAX_WATCHED_SPACES = 3;
export const PULSE_TURN_PAGE_LIMIT = 100;

export const PULSE_ORIGIN_CONFIGS = Object.freeze({
  local: Object.freeze({
    apiOrigin: "http://127.0.0.1:8787",
    gatewayOrigin: "ws://127.0.0.1:8788/ws",
  }),
  cloud: Object.freeze({
    apiOrigin: "https://api.cohub.live",
    gatewayOrigin: "wss://gateway.cohub.live/ws",
  }),
});

export const PULSE_ACTIVE_STATUSES = new Set([
  "queued",
  "running",
  "abort_requested",
]);
export const PULSE_TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
  "merged",
  "cancelled",
]);
export const PULSE_LIFECYCLE_STATUSES = new Set([
  ...PULSE_ACTIVE_STATUSES,
  ...PULSE_TERMINAL_STATUSES,
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT_ID_PATTERN = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const PULSE_WATCH_ENVELOPE_KEYS = [
  "digest",
  "expiresAt",
  "focus",
  "leaseExpiresAt",
  "ownerUserId",
  "protocolVersion",
  "revision",
  "type",
  "watchedSpaces",
];
const DISPLAY_NAME_MAX_SCALARS = 255;
const DISPLAY_NAME_MAX_BYTES = 1_020;

const defaultScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

export class PulseHttpError extends Error {
  constructor(status, path, body = null) {
    super(`Pulse API returned HTTP ${status} for ${path}`);
    this.name = "PulseHttpError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export class PulseAccountMismatchError extends Error {
  constructor(expected, actual) {
    super(`Cloud account mismatch: expected ${expected}, received ${actual ?? "missing uuid"}`);
    this.name = "PulseAccountMismatchError";
    this.expected = expected;
    this.actual = actual ?? null;
  }
}

export class PulseSpaceRejectedError extends Error {
  constructor(origin, spaceId) {
    super(`Pulse access rejected for ${origin} Space ${spaceId}`);
    this.name = "PulseSpaceRejectedError";
    this.origin = origin;
    this.spaceId = spaceId;
    this.status = 403;
  }
}

export class PulseStatePersistenceError extends Error {
  constructor(path, cause) {
    super(`Failed to persist pulse watch state at ${path}`, { cause });
    this.name = "PulseStatePersistenceError";
    this.path = path;
  }
}

function fail(path, message) {
  throw new TypeError(`Invalid pulse watch state at ${path}: ${message}`);
}

function requireRecord(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value;
}

function requireString(value, path, { uuid = false, maxLength } = {}) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(path, "must be a non-empty string");
  }
  const normalized = value.trim();
  if (uuid && !UUID_PATTERN.test(normalized)) fail(path, "must be a UUID");
  if (maxLength !== undefined && normalized.length > maxLength) {
    fail(path, `must not exceed ${maxLength} characters`);
  }
  return normalized;
}

function requireTimestamp(value, path) {
  const normalized = requireString(value, path, { maxLength: 64 });
  if (!Number.isFinite(Date.parse(normalized))) fail(path, "must be an ISO timestamp");
  return normalized;
}

function requireOrigin(value, path) {
  if (value !== "local" && value !== "cloud") {
    fail(path, "must be local or cloud");
  }
  return value;
}

function normalizeDisplayName(value, path) {
  const normalized = requireString(value, path);
  const scalars = [...normalized];
  if (scalars.length > DISPLAY_NAME_MAX_SCALARS) {
    fail(path, `must not exceed ${DISPLAY_NAME_MAX_SCALARS} Unicode scalars`);
  }
  if (Buffer.byteLength(normalized, "utf8") > DISPLAY_NAME_MAX_BYTES) {
    fail(path, `must not exceed ${DISPLAY_NAME_MAX_BYTES} UTF-8 bytes`);
  }
  if (
    scalars.some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
        codePoint === 0x2028 ||
        codePoint === 0x2029
      );
    })
  ) {
    fail(path, "must not contain control characters");
  }
  return normalized;
}

function normalizeSpaceRef(value, path) {
  const ref = requireRecord(value, path);
  return {
    origin: requireOrigin(ref.origin, `${path}.origin`),
    spaceId: requireString(ref.spaceId, `${path}.spaceId`, { uuid: true }),
  };
}

function normalizeFocus(value, path) {
  if (value === null || value === undefined) return null;
  const focus = requireRecord(value, path);
  if (typeof focus.explicit !== "boolean") fail(`${path}.explicit`, "must be a boolean");
  return {
    ...normalizeSpaceRef(focus, path),
    sessionId:
      focus.sessionId === null
        ? null
        : requireString(focus.sessionId, `${path}.sessionId`, { uuid: true }),
    explicit: focus.explicit,
  };
}

export function normalizePulseWatchSnapshot(value, path = "watch") {
  const watch = requireRecord(value, path);
  if (!Number.isSafeInteger(watch.revision) || watch.revision < 1) {
    fail(`${path}.revision`, "must be a positive safe integer");
  }
  if (!Array.isArray(watch.watchedSpaces)) fail(`${path}.watchedSpaces`, "must be an array");
  if (watch.watchedSpaces.length > PULSE_MAX_WATCHED_SPACES) {
    fail(`${path}.watchedSpaces`, `must contain at most ${PULSE_MAX_WATCHED_SPACES} Spaces`);
  }
  const watchedSpaces = watch.watchedSpaces.map((space, index) =>
    normalizeSpaceRef(space, `${path}.watchedSpaces[${index}]`),
  );
  const keys = watchedSpaces.map(spaceKey);
  if (new Set(keys).size !== keys.length) fail(`${path}.watchedSpaces`, "must not contain duplicates");
  const expiresAt = requireTimestamp(watch.expiresAt, `${path}.expiresAt`);
  const leaseExpiresAt = requireTimestamp(watch.leaseExpiresAt, `${path}.leaseExpiresAt`);
  return {
    ownerUserId: (() => {
      const ownerUserId = requireString(watch.ownerUserId, `${path}.ownerUserId`, {
        maxLength: 36,
      }).toLowerCase();
      if (!ACCOUNT_ID_PATTERN.test(ownerUserId)) {
        fail(`${path}.ownerUserId`, "must be a 32-hex account id or UUID");
      }
      return ownerUserId;
    })(),
    revision: watch.revision,
    expiresAt,
    leaseExpiresAt,
    watchedSpaces,
    focus: normalizeFocus(watch.focus, `${path}.focus`),
  };
}

export function normalizePulseWatchEnvelope(value, path = "message") {
  const envelope = requireRecord(value, path);
  const keys = Object.keys(envelope).sort();
  if (
    keys.length !== PULSE_WATCH_ENVELOPE_KEYS.length ||
    keys.some((key, index) => key !== PULSE_WATCH_ENVELOPE_KEYS[index])
  ) {
    fail(path, "has an invalid Activity watch envelope shape");
  }
  if (envelope.protocolVersion !== 2 || envelope.type !== "activity-watch.replace") {
    fail(path, "has an unsupported Activity watch protocol");
  }
  if (typeof envelope.digest !== "string" || !SHA256_PATTERN.test(envelope.digest)) {
    fail(`${path}.digest`, "must be a SHA-256 digest");
  }
  return {
    protocolVersion: 2,
    type: "activity-watch.replace",
    digest: envelope.digest.toLowerCase(),
    ...normalizePulseWatchSnapshot(envelope, path),
  };
}

function normalizeKnownTurn(value, path) {
  const turn = requireRecord(value, path);
  const status = requireString(turn.status, `${path}.status`, { maxLength: 32 });
  if (!PULSE_LIFECYCLE_STATUSES.has(status)) fail(`${path}.status`, "is unsupported");
  return {
    origin: requireOrigin(turn.origin, `${path}.origin`),
    spaceId: requireString(turn.spaceId, `${path}.spaceId`, { uuid: true }),
    sessionId: requireString(turn.sessionId, `${path}.sessionId`, { uuid: true }),
    turnId: requireString(turn.turnId, `${path}.turnId`, { uuid: true }),
    status,
    updatedAt: requireTimestamp(turn.updatedAt, `${path}.updatedAt`),
    spaceName: normalizeDisplayName(turn.spaceName, `${path}.spaceName`),
    sessionTitle: normalizeDisplayName(turn.sessionTitle, `${path}.sessionTitle`),
  };
}

function normalizePendingEvent(value, path) {
  const event = requireRecord(value, path);
  if (event.kind !== "turn.lifecycle") fail(`${path}.kind`, "must be turn.lifecycle");
  const status = requireString(event.status, `${path}.status`, { maxLength: 32 });
  if (!PULSE_LIFECYCLE_STATUSES.has(status)) fail(`${path}.status`, "is unsupported");
  return {
    id: requireString(event.id, `${path}.id`, { uuid: true }),
    kind: "turn.lifecycle",
    nodeId: requireString(event.nodeId, `${path}.nodeId`, { maxLength: 100 }),
    origin: requireOrigin(event.origin, `${path}.origin`),
    spaceId: requireString(event.spaceId, `${path}.spaceId`, { uuid: true }),
    sessionId: requireString(event.sessionId, `${path}.sessionId`, { uuid: true }),
    turnId: requireString(event.turnId, `${path}.turnId`, { uuid: true }),
    status,
    observedAt: requireTimestamp(event.observedAt, `${path}.observedAt`),
    spaceName: normalizeDisplayName(event.spaceName, `${path}.spaceName`),
    sessionTitle: normalizeDisplayName(event.sessionTitle, `${path}.sessionTitle`),
  };
}

export function emptyPulseState() {
  return { version: 1, watch: null, knownTurns: [], pendingEvents: [] };
}

export function normalizePulseState(value, path = "state") {
  const state = requireRecord(value, path);
  if (state.version !== 1) fail(`${path}.version`, "must equal 1");
  if (!Array.isArray(state.knownTurns)) fail(`${path}.knownTurns`, "must be an array");
  if (!Array.isArray(state.pendingEvents)) fail(`${path}.pendingEvents`, "must be an array");
  const knownTurns = state.knownTurns.map((turn, index) =>
    normalizeKnownTurn(turn, `${path}.knownTurns[${index}]`),
  );
  const pendingEvents = state.pendingEvents.map((event, index) =>
    normalizePendingEvent(event, `${path}.pendingEvents[${index}]`),
  );
  const knownKeys = knownTurns.map(turnKey);
  if (new Set(knownKeys).size !== knownKeys.length) fail(`${path}.knownTurns`, "must have unique keys");
  const eventIds = pendingEvents.map((event) => event.id);
  if (new Set(eventIds).size !== eventIds.length) fail(`${path}.pendingEvents`, "must have unique ids");
  return {
    version: 1,
    watch: state.watch === null ? null : normalizePulseWatchSnapshot(state.watch, `${path}.watch`),
    knownTurns,
    pendingEvents,
  };
}

export function pulseStatePath(dataDir) {
  return join(dataDir, PULSE_STATE_FILENAME);
}

export async function atomicWritePulseState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

export async function loadPulseState(path) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyPulseState();
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new TypeError(`Invalid pulse watch state at ${path}: malformed JSON`, { cause: error });
  }
  try {
    return normalizePulseState(parsed);
  } catch (error) {
    throw new TypeError(`Invalid pulse watch state at ${path}: ${error.message}`, { cause: error });
  }
}

function spaceKey(space) {
  return `${space.origin}:${space.spaceId}`;
}

function turnKey(turn) {
  return `${turn.origin}:${turn.spaceId}:${turn.turnId}`;
}

function eligibleSpaceRefs(watch) {
  const refs = new Map(watch.watchedSpaces.map((space) => [spaceKey(space), space]));
  if (watch.focus) refs.set(spaceKey(watch.focus), {
    origin: watch.focus.origin,
    spaceId: watch.focus.spaceId,
  });
  return [...refs.values()];
}

function isWithinScope(turn, watch) {
  const watched = watch.watchedSpaces.some(
    (space) => space.origin === turn.origin && space.spaceId === turn.spaceId,
  );
  if (watched) return true;
  return Boolean(
    watch.focus &&
      watch.focus.origin === turn.origin &&
      watch.focus.spaceId === turn.spaceId &&
      (watch.focus.sessionId === null || watch.focus.sessionId === turn.sessionId),
  );
}

function effectiveExpiryMs(watch) {
  return Math.min(Date.parse(watch.expiresAt), Date.parse(watch.leaseExpiresAt));
}

function sameWatchScope(left, right) {
  return (
    left.ownerUserId === right.ownerUserId &&
    JSON.stringify(left.watchedSpaces) === JSON.stringify(right.watchedSpaces) &&
    JSON.stringify(left.focus) === JSON.stringify(right.focus)
  );
}

function isWatchLive(watch, nowMs) {
  return Boolean(watch && effectiveExpiryMs(watch) > nowMs);
}

function responseBody(response) {
  return response
    .clone()
    .json()
    .catch(() => response.text().catch(() => null));
}

function sanitizeToken(value) {
  if (typeof value !== "string") return null;
  const token = value.replace(/[\r\n\t\0]/g, "").trim();
  return token || null;
}

function normalizeApiTurn(value, origin, spaceId, spaceName) {
  const turn = requireRecord(value, "API turn");
  const session = requireRecord(turn.session, "API turn.session");
  const status = requireString(turn.status, "API turn.status", { maxLength: 32 });
  if (!PULSE_LIFECYCLE_STATUSES.has(status)) fail("API turn.status", "is unsupported");
  return {
    origin,
    spaceId,
    sessionId: requireString(turn.sessionId, "API turn.sessionId", { uuid: true }),
    turnId: requireString(turn.id, "API turn.id", { uuid: true }),
    status,
    updatedAt: requireTimestamp(turn.updatedAt, "API turn.updatedAt"),
    spaceName: normalizeDisplayName(spaceName, "API Space.name"),
    sessionTitle: normalizeDisplayName(session.title, "API turn.session.title"),
  };
}

function createLifecycleEvent(turn, nodeId) {
  return {
    id: randomUUID(),
    kind: "turn.lifecycle",
    nodeId,
    origin: turn.origin,
    spaceId: turn.spaceId,
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    status: turn.status,
    observedAt: turn.updatedAt,
    spaceName: turn.spaceName,
    sessionTitle: turn.sessionTitle,
  };
}

function shouldEmitTurn(previous, current) {
  if (PULSE_ACTIVE_STATUSES.has(current.status)) {
    return (
      !previous ||
      previous.status !== current.status ||
      previous.updatedAt !== current.updatedAt
    );
  }
  return Boolean(previous && previous.status !== current.status);
}

function createHttpContext({ origin, config, ownerUserId, fetcher, getAccessToken }) {
  let token = null;
  let refreshed = false;
  let verifiedCloudToken = null;

  const resolveToken = async (forceRefresh) => {
    const resolved = sanitizeToken(await getAccessToken(forceRefresh));
    if (!resolved) throw new Error("Pulse access token is unavailable");
    token = resolved;
    return resolved;
  };

  const send = async (path, bearer) =>
    fetcher(new URL(path, `${config.apiOrigin}/`), {
      method: "GET",
      headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
    });

  const verifyCloud = async (bearer) => {
    if (origin !== "cloud" || verifiedCloudToken === bearer) return;
    const response = await send("/api/me", bearer);
    if (response.status === 401) return false;
    if (!response.ok) throw new PulseHttpError(response.status, "/api/me", await responseBody(response));
    const me = requireRecord(await response.json(), "cloud /api/me");
    const actual =
      typeof me.uuid === "string" ? me.uuid.trim().toLowerCase() : null;
    if (actual !== ownerUserId) throw new PulseAccountMismatchError(ownerUserId, actual);
    verifiedCloudToken = bearer;
    return true;
  };

  const refreshAndVerify = async () => {
    if (refreshed) return false;
    refreshed = true;
    const next = await resolveToken(true);
    if (origin === "cloud") {
      const verified = await verifyCloud(next);
      if (!verified) return false;
    }
    return true;
  };

  return {
    async start() {
      const initial = await resolveToken(false);
      if (origin === "cloud") {
        const verified = await verifyCloud(initial);
        if (!verified) {
          if (!(await refreshAndVerify())) throw new PulseHttpError(401, "/api/me");
        }
      }
    },
    async json(path) {
      if (!token) throw new Error("Pulse HTTP context was not started");
      let response = await send(path, token);
      if (response.status === 401 && (await refreshAndVerify())) {
        response = await send(path, token);
      }
      if (!response.ok) {
        throw new PulseHttpError(response.status, path, await responseBody(response));
      }
      return response.json();
    },
    clear() {
      token = null;
      verifiedCloudToken = null;
    },
  };
}

function createDefaultRealtimeConnection({
  config,
  spaces,
  getAccessToken,
  onWake,
  onConnection,
  onError,
}) {
  let socket = null;
  let stopped = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let pingTimer = null;
  let forceRefresh = false;
  let credential = null;
  const rooms = spaces.map((space) => `space:${space.spaceId}`);

  const clearTimers = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (pingTimer) clearInterval(pingTimer);
    reconnectTimer = null;
    pingTimer = null;
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(1_000 * 2 ** reconnectAttempt, 15_000);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  };

  const connect = async () => {
    if (stopped) return;
    onConnection("connecting");
    try {
      credential = sanitizeToken(await getAccessToken({ forceRefresh }));
      forceRefresh = false;
      if (!credential) throw new Error("Pulse realtime access token is unavailable");
    } catch (error) {
      onError(error);
      onConnection("disconnected");
      scheduleReconnect();
      return;
    }
    const ws = new WebSocket(config.gatewayOrigin);
    socket = ws;
    ws.on("open", () => {
      const token = credential;
      credential = null;
      if (!token) {
        ws.close(4003, "missing access token");
        return;
      }
      ws.send(
        JSON.stringify({
          type: "auth",
          payload: { token, capabilities: ["realtime.rooms.v1"] },
        }),
      );
    });
    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type === "system.auth.ok") {
        reconnectAttempt = 0;
        onConnection("connected");
        ws.send(JSON.stringify({ type: "subscribe", payload: { rooms } }));
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping", payload: {} }));
          }
        }, 20_000);
        return;
      }
      if (message.type === "system.request.error" && message.payload?.code === "UNAUTHORIZED") {
        forceRefresh = true;
        ws.close(4003, "authentication failed");
        return;
      }
      if (
        typeof message.spaceId === "string" &&
        spaces.some((space) => space.spaceId === message.spaceId)
      ) {
        onWake();
      }
    });
    ws.on("error", (error) => onError(error));
    ws.on("close", () => {
      credential = null;
      if (socket === ws) socket = null;
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;
      onConnection("disconnected");
      scheduleReconnect();
    });
  };

  void connect();
  return {
    async close() {
      stopped = true;
      credential = null;
      clearTimers();
      const ws = socket;
      socket = null;
      if (ws && ws.readyState < WebSocket.CLOSING) ws.close(1000, "pulse watch stopped");
      onConnection("disconnected");
    },
  };
}

export function createPulseWatcher({
  dataDir,
  getAccessToken,
  onEvent,
  onError = () => {},
  nodeId = "mac-mini",
  fetcher = globalThis.fetch,
  originConfigs = PULSE_ORIGIN_CONFIGS,
  createRealtimeConnection = createDefaultRealtimeConnection,
  scheduler = defaultScheduler,
  now = () => Date.now(),
  reconcileIntervalMs = PULSE_RECONCILE_INTERVAL_MS,
  disconnectedPollMs = PULSE_DISCONNECTED_POLL_MS,
  writeState = atomicWritePulseState,
} = {}) {
  if (!dataDir) throw new TypeError("dataDir is required");
  if (typeof getAccessToken !== "function") throw new TypeError("getAccessToken is required");
  if (typeof onEvent !== "function") throw new TypeError("onEvent is required");
  if (typeof fetcher !== "function") throw new TypeError("fetcher is required");

  const path = pulseStatePath(dataDir);
  let state = emptyPulseState();
  let started = false;
  let stopped = false;
  let generation = 0;
  let reconcilePromise = null;
  let reconcileAgain = false;
  let reconcileTimer = null;
  let expiryTimer = null;
  let writeChain = Promise.resolve();
  const realtimeByOrigin = new Map();
  const connectionState = new Map([
    ["local", "disconnected"],
    ["cloud", "disconnected"],
  ]);

  const reportError = (error) => {
    try {
      const result = onError(error);
      if (result?.catch) result.catch(() => {});
    } catch {
      // Reporting must not hide the original collector failure.
    }
  };

  const persist = () => {
    const snapshot = structuredClone(state);
    const task = writeChain.then(() => writeState(path, snapshot)).catch((error) => {
      if (error instanceof PulseStatePersistenceError) throw error;
      throw new PulseStatePersistenceError(path, error);
    });
    writeChain = task.catch(() => {});
    return task;
  };

  const emit = (event) => {
    try {
      const result = onEvent(event);
      if (result?.catch) result.catch(reportError);
    } catch (error) {
      reportError(error);
    }
  };

  const clearTimer = (name) => {
    const handle = name === "reconcile" ? reconcileTimer : expiryTimer;
    if (handle !== null) scheduler.clearTimeout(handle);
    if (name === "reconcile") reconcileTimer = null;
    else expiryTimer = null;
  };

  const isAnyDisconnected = () => {
    const activeOrigins = new Set(eligibleSpaceRefs(state.watch).map((space) => space.origin));
    return [...activeOrigins].some((origin) => connectionState.get(origin) !== "connected");
  };

  const scheduleReconcile = (delayMs) => {
    if (stopped || !isWatchLive(state.watch, now())) return;
    clearTimer("reconcile");
    reconcileTimer = scheduler.setTimeout(() => {
      reconcileTimer = null;
      void reconcile("scheduled").catch(reportError);
    }, delayMs);
  };

  const scheduleNextReconcile = () => {
    scheduleReconcile(isAnyDisconnected() ? disconnectedPollMs : reconcileIntervalMs);
  };

  const closeRealtime = async () => {
    const connections = [...realtimeByOrigin.values()];
    realtimeByOrigin.clear();
    await Promise.allSettled(connections.map((connection) => connection.close()));
    connectionState.set("local", "disconnected");
    connectionState.set("cloud", "disconnected");
  };

  const expire = async () => {
    generation += 1;
    clearTimer("reconcile");
    clearTimer("expiry");
    await closeRealtime();
    if (state.knownTurns.length > 0 || state.pendingEvents.length > 0) {
      const previousState = state;
      state = structuredClone(state);
      state.knownTurns = [];
      state.pendingEvents = [];
      try {
        await persist();
      } catch (error) {
        state = previousState;
        throw error;
      }
    }
  };

  const scheduleExpiry = () => {
    clearTimer("expiry");
    if (!state.watch) return;
    const remaining = effectiveExpiryMs(state.watch) - now();
    if (remaining <= 0) {
      void expire().catch(reportError);
      return;
    }
    expiryTimer = scheduler.setTimeout(() => {
      expiryTimer = null;
      void expire().catch(reportError);
    }, remaining);
  };

  const configureRealtime = async () => {
    await closeRealtime();
    if (!isWatchLive(state.watch, now())) return;
    const byOrigin = new Map();
    for (const space of eligibleSpaceRefs(state.watch)) {
      const spaces = byOrigin.get(space.origin) ?? [];
      spaces.push(space);
      byOrigin.set(space.origin, spaces);
    }
    for (const [origin, spaces] of byOrigin) {
      const config = originConfigs[origin];
      if (!config) throw new Error(`Pulse origin ${origin} is not configured`);
      const connection = createRealtimeConnection({
        origin,
        config,
        spaces,
        getAccessToken: async (options = {}) => {
          if (!isWatchLive(state.watch, now())) return null;
          return getAccessToken(options.forceRefresh === true);
        },
        onWake: () => scheduleReconcile(0),
        onConnection: (status) => {
          connectionState.set(origin, status);
          if (status === "connected") scheduleReconcile(0);
          else scheduleReconcile(disconnectedPollMs);
        },
        onError: reportError,
      });
      realtimeByOrigin.set(origin, connection);
    }
  };

  const fetchSpaceTurns = async (http, origin, ref, watch) => {
    let space;
    try {
      space = await http.json(`/api/spaces/${encodeURIComponent(ref.spaceId)}`);
    } catch (error) {
      if (error instanceof PulseHttpError && error.status === 403) {
        throw new PulseSpaceRejectedError(origin, ref.spaceId);
      }
      throw error;
    }
    const spaceRecord = space?.space ?? space;
    const spaceName = normalizeDisplayName(spaceRecord?.name, "API Space.name");
    const watched = watch.watchedSpaces.some(
      (candidate) => candidate.origin === origin && candidate.spaceId === ref.spaceId,
    );
    const focusSessionId =
      watch.focus?.origin === origin && watch.focus.spaceId === ref.spaceId
        ? watch.focus.sessionId
        : null;
    const query = new URLSearchParams({ limit: String(PULSE_TURN_PAGE_LIMIT) });
    if (!watched && focusSessionId) query.set("sessionId", focusSessionId);
    let response;
    try {
      response = await http.json(
        `/api/spaces/${encodeURIComponent(ref.spaceId)}/turns?${query.toString()}`,
      );
    } catch (error) {
      if (error instanceof PulseHttpError && error.status === 403) {
        throw new PulseSpaceRejectedError(origin, ref.spaceId);
      }
      throw error;
    }
    if (!Array.isArray(response?.turns)) fail("API turns", "must be an array");
    return response.turns
      .map((turn) => normalizeApiTurn(turn, origin, ref.spaceId, spaceName))
      .filter((turn) => isWithinScope(turn, watch));
  };

  const recoverMissingKnownTurns = async (httpByOrigin, currentByKey, watch) => {
    const recovered = [];
    for (const known of state.knownTurns) {
      if (!PULSE_ACTIVE_STATUSES.has(known.status) || !isWithinScope(known, watch)) continue;
      if (currentByKey.has(turnKey(known))) continue;
      const http = httpByOrigin.get(known.origin);
      if (!http) continue;
      try {
        const response = await http.json(
          `/api/sessions/${encodeURIComponent(known.sessionId)}/turns/${encodeURIComponent(known.turnId)}`,
        );
        recovered.push(
          normalizeApiTurn(
            { ...response.turn, session: response.session },
            known.origin,
            known.spaceId,
            known.spaceName,
          ),
        );
      } catch (error) {
        if (error instanceof PulseHttpError && (error.status === 403 || error.status === 404)) {
          if (error.status === 403) reportError(new PulseSpaceRejectedError(known.origin, known.spaceId));
          continue;
        }
        throw error;
      }
    }
    return recovered;
  };

  const runReconcile = async () => {
    const watch = state.watch;
    const capturedGeneration = generation;
    if (!isWatchLive(watch, now())) {
      await expire();
      return [];
    }
    const refs = eligibleSpaceRefs(watch);
    const httpByOrigin = new Map();
    try {
      for (const origin of new Set(refs.map((ref) => ref.origin))) {
        const config = originConfigs[origin];
        if (!config) throw new Error(`Pulse origin ${origin} is not configured`);
        const context = createHttpContext({
          origin,
          config,
          ownerUserId: watch.ownerUserId,
          fetcher,
          getAccessToken,
        });
        await context.start();
        httpByOrigin.set(origin, context);
      }

      const currentTurns = [];
      for (const ref of refs) {
        try {
          currentTurns.push(
            ...(await fetchSpaceTurns(httpByOrigin.get(ref.origin), ref.origin, ref, watch)),
          );
        } catch (error) {
          if (error instanceof PulseSpaceRejectedError) {
            reportError(error);
            continue;
          }
          throw error;
        }
      }
      const currentByKey = new Map(currentTurns.map((turn) => [turnKey(turn), turn]));
      for (const turn of await recoverMissingKnownTurns(httpByOrigin, currentByKey, watch)) {
        currentByKey.set(turnKey(turn), turn);
      }

      if (
        stopped ||
        generation !== capturedGeneration ||
        state.watch?.revision !== watch.revision ||
        !isWatchLive(state.watch, now())
      ) {
        return [];
      }

      const previousByKey = new Map(state.knownTurns.map((turn) => [turnKey(turn), turn]));
      const events = [];
      for (const current of currentByKey.values()) {
        const previous = previousByKey.get(turnKey(current));
        if (shouldEmitTurn(previous, current)) events.push(createLifecycleEvent(current, nodeId));
        previousByKey.set(turnKey(current), current);
      }
      const nextKnownTurns = [...previousByKey.values()]
        .filter((turn) => isWithinScope(turn, watch))
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, 500);
      if (events.length > 0 || currentByKey.size > 0) {
        const previousState = state;
        state = structuredClone(state);
        state.knownTurns = nextKnownTurns;
        state.pendingEvents.push(...events);
        try {
          await persist();
        } catch (error) {
          state = previousState;
          throw error;
        }
      } else {
        state.knownTurns = nextKnownTurns;
      }
      for (const event of events) emit(event);
      return events;
    } finally {
      for (const context of httpByOrigin.values()) context.clear();
    }
  };

  const reconcile = async (_reason = "manual") => {
    if (reconcilePromise) {
      reconcileAgain = true;
      return reconcilePromise;
    }
    clearTimer("reconcile");
    reconcilePromise = (async () => {
      let result = [];
      do {
        reconcileAgain = false;
        result = await runReconcile();
      } while (reconcileAgain && !stopped && isWatchLive(state.watch, now()));
      return result;
    })();
    try {
      return await reconcilePromise;
    } finally {
      reconcilePromise = null;
      if (!stopped && isWatchLive(state.watch, now())) scheduleNextReconcile();
    }
  };

  const acknowledgeEvent = async (eventId) => {
    requireString(eventId, "eventId", { uuid: true });
    const next = state.pendingEvents.filter((event) => event.id !== eventId);
    if (next.length === state.pendingEvents.length) return false;
    const previousState = state;
    state = structuredClone(state);
    state.pendingEvents = next;
    try {
      await persist();
    } catch (error) {
      state = previousState;
      throw error;
    }
    return true;
  };

  return {
    async start() {
      if (started) return;
      state = await loadPulseState(path);
      started = true;
      stopped = false;
      if (!isWatchLive(state.watch, now())) {
        await expire();
        return;
      }
      for (const event of state.pendingEvents) emit(event);
      scheduleExpiry();
      await configureRealtime();
      await reconcile("startup");
    },

    async replaceWatch(input) {
      if (!started) throw new Error("Pulse watcher is not started");
      const watch = normalizePulseWatchSnapshot(input);
      const current = state.watch;
      if (current && watch.revision < current.revision) {
        throw new Error(`Pulse watch revision ${watch.revision} is older than ${current.revision}`);
      }
      if (current && watch.revision === current.revision) {
        if (!sameWatchScope(current, watch)) {
          throw new Error(`Pulse watch revision ${watch.revision} conflicts with persisted state`);
        }
        const expiresAtMs = Date.parse(watch.expiresAt);
        const leaseExpiresAtMs = Date.parse(watch.leaseExpiresAt);
        const currentExpiresAtMs = Date.parse(current.expiresAt);
        const currentLeaseExpiresAtMs = Date.parse(current.leaseExpiresAt);
        if (
          expiresAtMs < currentExpiresAtMs ||
          leaseExpiresAtMs < currentLeaseExpiresAtMs ||
          (expiresAtMs === currentExpiresAtMs && leaseExpiresAtMs === currentLeaseExpiresAtMs)
        ) {
          return false;
        }
        const previousState = state;
        state = structuredClone(state);
        state.watch = watch;
        try {
          await persist();
        } catch (error) {
          state = previousState;
          throw error;
        }
        scheduleExpiry();
        if (isWatchLive(watch, now())) scheduleNextReconcile();
        return true;
      }
      const previousState = state;
      const previousGeneration = generation;
      generation += 1;
      state = structuredClone(state);
      const ownerChanged = current && current.ownerUserId !== watch.ownerUserId;
      state.watch = watch;
      state.knownTurns = ownerChanged
        ? []
        : state.knownTurns.filter((turn) => isWithinScope(turn, watch));
      state.pendingEvents = ownerChanged
        ? []
        : state.pendingEvents.filter((event) => isWithinScope(event, watch));
      try {
        await persist();
      } catch (error) {
        state = previousState;
        generation = previousGeneration;
        throw error;
      }
      scheduleExpiry();
      try {
        await configureRealtime();
      } catch (error) {
        reportError(error);
      }
      if (!isWatchLive(watch, now())) {
        await expire();
        return true;
      }
      try {
        await reconcile("watch-replaced");
      } catch (error) {
        if (error instanceof PulseStatePersistenceError) throw error;
        reportError(error);
      }
      return true;
    },

    async revoke(revision) {
      if (!started) throw new Error("Pulse watcher is not started");
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new TypeError("Pulse revoke revision must be a non-negative safe integer");
      }
      if (state.watch && revision < state.watch.revision) return false;
      const previousState = state;
      const previousGeneration = generation;
      generation += 1;
      state = structuredClone(state);
      state.watch = null;
      state.knownTurns = [];
      state.pendingEvents = [];
      try {
        await persist();
      } catch (error) {
        state = previousState;
        generation = previousGeneration;
        throw error;
      }
      await expire();
      return true;
    },

    acknowledge: acknowledgeEvent,
    ack: acknowledgeEvent,

    flushPending() {
      if (!isWatchLive(state.watch, now())) return 0;
      for (const event of state.pendingEvents) emit(event);
      return state.pendingEvents.length;
    },

    reconcileNow: () => reconcile("manual"),

    snapshot() {
      return structuredClone(state);
    },

    async stop() {
      if (!started || stopped) return;
      stopped = true;
      generation += 1;
      clearTimer("reconcile");
      clearTimer("expiry");
      await closeRealtime();
      if (reconcilePromise) await reconcilePromise.catch(() => {});
      await writeChain;
    },
  };
}
