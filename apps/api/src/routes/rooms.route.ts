import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AppRoomError, AppRoomSeatLostError } from "@cohub/infra/app-room";
import {
  createRoom,
  getRoom,
  HOSTED_EVENTS_MAX_WAIT_MS,
  HostedRoomError,
  type HostedCaller,
  inviteToRoom,
  joinRoom,
  leaveRoom,
  publishToRoom,
  readRoomEvents,
  resolveHostedCaller,
  setRoomPresence,
} from "../app-room-seats.js";
import { AppRoomOptionsError, appRoomOptionsErrorStatus } from "../app-rooms.js";
import { requireValidId } from "../lib/middleware.js";

const router = new Hono();

router.use("*", bodyLimit({
  maxSize: 24 * 1024,
  onError: (c) => c.json({ code: "PAYLOAD_TOO_LARGE", message: "request body is too large" }, 413),
}));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const body = async (c: Context) => {
  const value = await c.req.json<unknown>().catch(() => null);
  if (!isRecord(value)) throw new HostedRoomError(400, "INVALID_REQUEST", "Expected a JSON object.");
  return value;
};

const presenceOf = (value: unknown) => {
  if (value === null || isRecord(value)) return value;
  throw new HostedRoomError(400, "INVALID_PRESENCE", "presence must be a JSON object or null.");
};

const LOST_STATUS = { expired: 410, revoked: 404, superseded: 409 } as const;

function respond(c: Context, error: unknown) {
  if (error instanceof HostedRoomError) return c.json({ code: error.code, message: error.message }, error.status);
  if (error instanceof AppRoomSeatLostError) {
    return error.status === "expired"
      ? c.json({ code: "ROOM_EXPIRED", message: "This room has expired." }, 410)
      : c.json({ code: "ROOM_SEAT_NOT_FOUND", message: "You are not in this room. Join it with an invite first." }, LOST_STATUS[error.status]);
  }
  if (error instanceof AppRoomError) {
    const status = error.code === "ROOM_NOT_FOUND" ? 404 : error.code === "ROOM_EXPIRED" ? 410 : error.code === "RATE_LIMITED" ? 429 : 400;
    return c.json({ code: error.code, message: error.message }, status);
  }
  if (error instanceof AppRoomOptionsError) return c.json({ code: error.code, message: error.message }, appRoomOptionsErrorStatus(error));
  throw error;
}

const handle = (run: (c: Context, caller: HostedCaller, roomId: string) => Promise<unknown>) => async (c: Context) => {
  const roomId = c.req.param("roomId") ?? "";
  if (roomId && !requireValidId(roomId)) return c.json({ code: "ROOM_NOT_FOUND", message: "room not found" }, 404);
  const caller = await resolveHostedCaller(c);
  if (caller instanceof Response) return caller;
  try {
    return c.json(await run(c, caller, roomId));
  } catch (error) {
    return respond(c, error);
  }
};

router.post("/", async (c) => {
  try {
    const input = await body(c);
    if (typeof input.appId !== "string" || !requireValidId(input.appId)) {
      throw new HostedRoomError(400, "INVALID_REQUEST", "appId is required.");
    }
    const created = await createRoom(c, { ...input, appId: input.appId });
    return created instanceof Response ? created : c.json(created, 201);
  } catch (error) {
    return respond(c, error);
  }
});

router.post("/join", handle(async (c, caller) => {
  const input = await body(c);
  if (typeof input.invite !== "string") throw new HostedRoomError(400, "INVALID_INVITE", "invite is required.");
  return joinRoom(caller, {
    invite: input.invite,
    idleSeconds: input.idleSeconds,
    ...(input.presence !== undefined ? { presence: presenceOf(input.presence) } : {}),
  });
}));

router.get("/:roomId", handle((_c, caller, roomId) => getRoom(caller, roomId)));

router.get("/:roomId/events", handle((c, caller, roomId) => {
  const number = (name: string) => {
    const value = c.req.query(name);
    if (value === undefined || value === "") return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) throw new HostedRoomError(400, "INVALID_REQUEST", `${name} must be a non-negative integer.`);
    return parsed;
  };
  return readRoomEvents(caller, roomId, {
    after: number("after"),
    limit: number("limit"),
    waitMs: Math.min(number("wait") ?? 0, HOSTED_EVENTS_MAX_WAIT_MS),
    types: (c.req.query("types") ?? "").split(",").map((type) => type.trim()).filter(Boolean),
    signal: c.req.raw.signal,
  });
}));

router.post("/:roomId/events", handle(async (c, caller, roomId) => {
  const input = await body(c);
  if (typeof input.type !== "string") throw new HostedRoomError(400, "INVALID_REQUEST", "type is required.");
  return publishToRoom(caller, roomId, { type: input.type, data: input.data ?? null });
}));

router.put("/:roomId/presence", handle(async (c, caller, roomId) => {
  const input = await body(c);
  return setRoomPresence(caller, roomId, presenceOf(input.presence));
}));

router.post("/:roomId/invites", handle(async (c, caller, roomId) => {
  const input = await c.req.json<{ expiresInSeconds?: unknown }>().catch(() => ({}) as { expiresInSeconds?: unknown });
  const seconds = input.expiresInSeconds === undefined ? undefined : Number(input.expiresInSeconds);
  if (seconds !== undefined && (!Number.isInteger(seconds) || seconds < 60)) {
    throw new HostedRoomError(400, "INVALID_REQUEST", "expiresInSeconds must be an integer of at least 60.");
  }
  return inviteToRoom(caller, roomId, seconds);
}));

router.delete("/:roomId/seat", handle((_c, caller, roomId) => leaveRoom(caller, roomId)));

export default router;
