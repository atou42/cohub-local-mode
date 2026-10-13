import type { CohubHttpClient, RealtimeRoomMember, RoomEvent, RoomEvents, RoomView } from "@neta-art/cohub";
import type { Command } from "commander";
import { getAppByRef } from "../app-ref.js";
import { createClient } from "../client.js";
import { error, handleHttp, json as outJson, jsonRequested, ok, table, truncateText } from "../output.js";

const DURATION_RE = /^(\d+)(ms|s|m|h|d)?$/i;
const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(name: string, value: string): number {
  const match = DURATION_RE.exec(value.trim());
  if (!match) return error(`Invalid ${name}`, "Use a duration such as 90s, 10m or 2h.");
  return Number(match[1]) * (DURATION_UNITS[(match[2] ?? "s").toLowerCase()] ?? 1_000);
}

function seconds(name: string, value: string, range: [min: number, max: number]): number {
  const result = Math.round(parseDuration(name, value) / 1000);
  if (result < range[0] || result > range[1]) {
    return error(`Invalid ${name}`, `Use a duration from ${formatSeconds(range[0])} to ${formatSeconds(range[1])}.`);
  }
  return result;
}

const formatSeconds = (value: number) => (value % 3600 === 0 ? `${value / 3600}h` : value % 60 === 0 ? `${value / 60}m` : `${value}s`);

const MINUTE = 60;
const DAY = 24 * 60 * MINUTE;

function parseJson(name: string, value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return error(`Invalid ${name}`, `${name} must be JSON, e.g. '{"text":"hi"}'.`);
  }
}

async function readStdin(): Promise<string> {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function parsePresence(value: string): Record<string, unknown> | null {
  const presence = parseJson("presence", value);
  if (presence === null || (typeof presence === "object" && !Array.isArray(presence))) return presence as Record<string, unknown> | null;
  return error("Invalid presence", "presence must be a JSON object, or null to clear it.");
}

const short = (participantId: string) => participantId.slice(0, 8);

function printMembers(view: RoomView) {
  table(
    view.members.map((member: RealtimeRoomMember) => ({
      member: `${short(member.participantId)}${member.participantId === view.participantId ? " (you)" : ""}`,
      kind: member.kind ?? "user",
      model: member.model?.id ?? "",
      presence: member.presence ? truncateText(JSON.stringify(member.presence), 60) : "",
    })),
    [
      { key: "member", label: "Member" },
      { key: "kind", label: "Kind" },
      { key: "model", label: "Model" },
      { key: "presence", label: "Presence" },
    ],
  );
}

function printView(view: RoomView) {
  console.log(`Room ${view.room.code} · ${view.room.id}`);
  console.log(`You are ${view.participantId} · sequence ${view.sequence} · expires ${view.room.expiresAt}\n`);
  printMembers(view);
}

const formatEvent = (event: RoomEvent) =>
  `#${event.sequence} ${event.type} from ${event.self ? "you" : short(event.sender.participantId)} ${JSON.stringify(event.data)}`;

function printEvents(roomId: string, page: RoomEvents, options: { types: string[]; wait?: string }) {
  if (page.truncated) console.log("Some earlier events are no longer in the room history.");
  if (page.events.length === 0) console.log("No new events.");
  for (const event of page.events) console.log(formatEvent(event));
  const filter = options.types.map((type) => ` --type '${type}'`).join("");
  const wait = options.wait ? ` --wait ${options.wait}` : "";
  console.log(`\nNext: cohub rooms events ${roomId} --after ${page.cursor}${filter}${wait}`);
}

const collect = (value: string, previous: string[] = []) => [...previous, value];

async function withClient<T>(run: (client: CohubHttpClient) => Promise<T>) {
  try {
    return await run(createClient());
  } catch (e) {
    return handleHttp(e);
  }
}

export function registerRooms(program: Command): void {
  const rooms = program
    .command("rooms")
    .description("Take part in App rooms: join, read and publish events, set presence")
    .addHelpText("after", `
A room belongs to a published App. Join one with an invite from the App
(room.invite()), or create one for an App you manage. Your seat stays while
you use it and lapses after --idle without a call.

An Agent waits for the room in a background command and wakes when it returns:
  cohub rooms join <invite> --presence '{"name":"Guide"}'
  cohub rooms events <room> --type 'chat.*' --wait 10m
  cohub rooms publish <room> chat.message '{"text":"Hello"}'
`);

  rooms
    .command("create")
    .description("Create a room for an App you manage, with an invite and a link to it")
    .requiredOption("--app <app>", "App: ID, URL, or username/space/app")
    .option("--code <code>", "Room code people type or open with ?room=")
    .option("--ttl <duration>", "Room lifetime, 1m to 24h (default 2h)")
    .option("--max <count>", "Most members at once, 2 to 128 (default 16)")
    .option("--seat-per-user", "Give each person one App seat across tabs")
    .option("--json", "Output as JSON")
    .action((opts: { app: string; code?: string; ttl?: string; max?: string; seatPerUser?: boolean; json?: boolean }) =>
      withClient(async (client) => {
        const app = await getAppByRef(client, opts.app);
        const created = await client.rooms.create({
          appId: app.app.id,
          ...(opts.code ? { code: opts.code } : {}),
          ...(opts.ttl ? { expiresInSeconds: seconds("ttl", opts.ttl, [MINUTE, DAY]) } : {}),
          ...(opts.max ? { maxParticipants: Number(opts.max) } : {}),
          ...(opts.seatPerUser ? { seatPerUser: true } : {}),
        });
        if (jsonRequested(opts)) return outJson(created);
        console.log(`Room ${created.room.code} · ${created.room.id}`);
        if (created.url) console.log(`Open: ${created.url}`);
        console.log(`Invite (until ${created.expiresAt}):\n${created.invite}\n`);
        console.log(`Join: cohub rooms join <invite>`);
      }));

  rooms
    .command("join <invite>")
    .description("Take a seat in a room with an invite")
    .option("--presence <json>", "What others see about you, e.g. '{\"name\":\"Guide\"}'")
    .option("--idle <duration>", "Leave after this long without a call, 1m to 24h (default 30m)")
    .option("--json", "Output as JSON")
    .action((invite: string, opts: { presence?: string; idle?: string; json?: boolean }) =>
      withClient(async (client) => {
        const view = await client.rooms.join({
          invite,
          ...(opts.presence !== undefined ? { presence: parsePresence(opts.presence) } : {}),
          ...(opts.idle ? { idleSeconds: seconds("idle", opts.idle, [MINUTE, DAY]) } : {}),
        });
        if (jsonRequested(opts)) return outJson(view);
        printView(view);
        console.log(`\nWait for events: cohub rooms events ${view.room.id} --after ${view.sequence} --wait 10m`);
      }));

  rooms
    .command("get <room>")
    .description("Show the room, its members and your seat")
    .option("--json", "Output as JSON")
    .action((roomId: string, opts: { json?: boolean }) =>
      withClient(async (client) => {
        const view = await client.rooms.get(roomId);
        if (jsonRequested(opts)) return outJson(view);
        printView(view);
      }));

  rooms
    .command("events <room>")
    .description("Read published events, oldest first; --wait holds until someone else publishes")
    .option("--after <sequence>", "Only events after this sequence")
    .option("--type <pattern>", "Event type to include, * matches any text; repeatable", collect)
    .option("--wait <duration>", "Wait up to this long for a new event from someone else")
    .option("--follow", "Keep printing events as they arrive")
    .option("--limit <count>", "Most events to return")
    .option("--json", "Output as JSON")
    .action((roomId: string, opts: { after?: string; type?: string[]; wait?: string; follow?: boolean; limit?: string; json?: boolean }) =>
      withClient(async (client) => {
        const types = opts.type ?? [];
        const after = opts.after === undefined ? undefined : Number(opts.after);
        if (after !== undefined && (!Number.isInteger(after) || after < 0)) return error("Invalid --after", "Use a sequence number.");
        const limit = opts.limit === undefined ? undefined : Number(opts.limit);
        if (opts.follow) return follow(client, roomId, { after, types, json: jsonRequested(opts) });
        const page = await client.rooms.events(roomId, {
          after,
          types,
          ...(limit ? { limit } : {}),
          ...(opts.wait ? { waitMs: parseDuration("wait", opts.wait) } : {}),
        });
        if (jsonRequested(opts)) return outJson(page);
        printEvents(roomId, page, { types, wait: opts.wait });
      }));

  rooms
    .command("publish <room> <type> [data]")
    .description("Publish an event to everyone in the room; data is JSON, or - for stdin")
    .option("--json", "Output as JSON")
    .action((roomId: string, type: string, data: string | undefined, opts: { json?: boolean }) =>
      withClient(async (client) => {
        const payload = data === undefined ? null : parseJson("data", data === "-" ? await readStdin() : data);
        const result = await client.rooms.publish(roomId, type, payload);
        if (jsonRequested(opts)) return outJson(result);
        ok(`Published #${result.sequence} ${type}`);
      }));

  rooms
    .command("presence <room> <json>")
    .description("Set what others see about you; null clears it")
    .option("--json", "Output as JSON")
    .action((roomId: string, value: string, opts: { json?: boolean }) =>
      withClient(async (client) => {
        const result = await client.rooms.setPresence(roomId, parsePresence(value));
        if (jsonRequested(opts)) return outJson(result);
        ok("Presence updated");
      }));

  rooms
    .command("invite <room>")
    .description("Create an invite to a room you are in")
    .option("--ttl <duration>", "How long the invite admits people (default 10m)")
    .option("--json", "Output as JSON")
    .action((roomId: string, opts: { ttl?: string; json?: boolean }) =>
      withClient(async (client) => {
        const invite = await client.rooms.invite(roomId, opts.ttl ? { expiresInSeconds: seconds("ttl", opts.ttl, [MINUTE, DAY]) } : {});
        if (jsonRequested(opts)) return outJson(invite);
        console.log(`Invite (until ${invite.expiresAt}):\n${invite.invite}`);
      }));

  rooms
    .command("leave <room>")
    .description("Give up your seat")
    .option("--json", "Output as JSON")
    .action((roomId: string, opts: { json?: boolean }) =>
      withClient(async (client) => {
        const result = await client.rooms.leave(roomId);
        if (jsonRequested(opts)) return outJson(result);
        ok(result.left ? "Left the room" : "You were not in this room");
      }));
}

async function follow(client: CohubHttpClient, roomId: string, input: { after?: number; types: string[]; json: boolean }) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  let after = input.after ?? (await client.rooms.get(roomId)).sequence;
  while (!controller.signal.aborted) {
    const page = await client.rooms.events(roomId, { after, types: input.types, waitMs: 25_000, signal: controller.signal })
      .catch((e) => (controller.signal.aborted ? null : Promise.reject(e)));
    if (!page) break;
    for (const event of page.events) console.log(input.json ? JSON.stringify(event) : formatEvent(event));
    after = page.cursor;
  }
}
