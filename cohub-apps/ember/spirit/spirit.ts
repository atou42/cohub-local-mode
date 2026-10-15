import { readFileSync } from "node:fs";
import { createCohubClient, getCohubContext, type RoomEvent } from "@neta-art/cohub";
import { type CampEvent, createId, EVENTS, readChat, SPIRIT_ROLE } from "../src/camp/protocol.ts";
import { restoreCamp } from "../src/camp/restore.ts";
import { type CampState, reduce } from "../src/camp/state.ts";
import { FIRE, type Point } from "../src/camp/world.ts";
import {
  decide,
  greetingPrompt,
  type Heard,
  type Locale,
  LIMITS,
  musePrompt,
  NAME,
  namePrompt,
  type Pace,
  type Prompt,
  replyPrompt,
  tidy,
  tidyName,
  weavePosition,
  weavePrompt,
  wonClaim,
} from "./lib/mind.ts";
import { Quota } from "./lib/quota.ts";
import { Voice } from "./lib/voice.ts";

const POLL_WAIT_MS = 15_000;
const HISTORY_PAGE = 200;
const HISTORY_PAGES = 6;
const DRIFT_MS = 1_400;
const COLOR = "#8fe7ff";

type Input = { invite: string; locale: Locale; by: string };
type Member = { participantId: string; kind?: string; presence?: Record<string, unknown> | null };

const log = (event: string, fields: Record<string, unknown> = {}) =>
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);

const readInput = (): Input => {
  const raw = JSON.parse(readFileSync(0, "utf8") || "null") as Partial<Input> | null;
  if (!raw || typeof raw.invite !== "string" || raw.invite.length > 4096) throw new Error("spirit: an invite is required");
  return { invite: raw.invite, locale: raw.locale === "zh" ? "zh" : "en", by: typeof raw.by === "string" ? raw.by.slice(0, 24) : "" };
};

const guestsOf = (members: Member[]) =>
  members
    .filter((member) => member.kind === "user")
    .map((member) => (typeof member.presence?.name === "string" ? member.presence.name.slice(0, 24) : ""))
    .filter(Boolean);

const toCamp = (event: RoomEvent): CampEvent => ({ type: event.type, data: event.data, sequence: event.sequence, at: event.timestamp });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const input = readInput();
  const client = createCohubClient();
  if (typeof client.rooms?.join !== "function") throw new Error("spirit: this sandbox's Cohub SDK has no rooms; update it with `npm i -g @neta-art/cohub-cli`");
  const execution = getCohubContext().execution;
  const spaceId = execution?.spaceId ?? process.env.COHUB_SPACE_ID ?? "";
  const run = crypto.randomUUID();
  const quota = new Quota(run, execution?.viewerUserId ?? "");
  const refusal = quota.claim();
  if (refusal) throw new Error(refusal);
  setInterval(() => quota.beat(), 30_000).unref();
  process.once("exit", () => quota.release());

  const name = NAME[input.locale];
  let at: Point = { x: FIRE.x + 150, y: FIRE.y + 50 };
  const presence = (thinking: boolean) => ({ role: SPIRIT_ROLE, name, color: COLOR, thinking, x: Math.round(at.x), y: Math.round(at.y) });

  const joined = await client.rooms.join({ invite: input.invite, presence: presence(true), idleSeconds: 600 });
  const roomId = joined.room.id;
  log("joined", { roomId, run });

  await client.rooms.publish(roomId, EVENTS.awake, { run });
  const claim = await client.rooms.events(roomId, { after: Math.max(0, joined.sequence - 200), types: [EVENTS.awake, EVENTS.gone], limit: 200 });
  if (!wonClaim(claim.events, run, Date.now())) {
    log("duplicate", { roomId });
    await client.rooms.leave(roomId).catch(() => undefined);
    return;
  }

  const history: CampEvent[] = [];
  let cursor = 0;
  for (let page = 0; page < HISTORY_PAGES; page += 1) {
    const result = await client.rooms.events(roomId, { after: cursor, limit: HISTORY_PAGE });
    history.push(...result.events.map(toCamp));
    cursor = result.cursor;
    if (result.events.length < HISTORY_PAGE) break;
  }
  let camp: CampState = (await restoreCamp(history)).state;
  log("restored", { sequence: camp.sequence, cards: camp.cards.size, stars: camp.stars.size });

  const voice = new Voice(client, spaceId, input.locale);
  log("voice", { model: await voice.prepare() });

  const recent: Heard[] = [];
  const said: string[] = [];
  const woven = new Set<string>();
  const now = Date.now();
  const pace: Pace = { startedAt: now, spokeAt: 0, heardAt: now, actedAt: now, spoken: 0, woven: 0, named: 0 };
  let members = (joined.members ?? []) as Member[];

  const setPresence = (thinking: boolean) => client.rooms.setPresence(roomId, presence(thinking)).catch(() => undefined);

  const drift = async (to: Point) => {
    at = to;
    await setPresence(true);
    await sleep(DRIFT_MS);
  };

  const think = async (prompt: Prompt, maxTokens = 300) => {
    const completion = await client.space(spaceId).completion({
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      maxTokens,
      thinkingLevel: "off",
    });
    return completion.message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  };

  const speak = async (prompt: Prompt) => {
    await setPresence(true);
    let text = "";
    try {
      text = tidy(await think(prompt));
    } finally {
      await setPresence(false);
    }
    if (!text) return;
    const id = `${run.slice(0, 8)}${pace.spoken}`;
    await client.rooms.publish(roomId, EVENTS.speak, { id, text, name });
    said.push(text);
    pace.spoken += 1;
    pace.spokeAt = Date.now();
    const audio = await voice.speak(text).catch((error: unknown) => {
      log("voice_failed", { message: (error as Error).message });
      return null;
    });
    if (audio) await client.rooms.publish(roomId, EVENTS.voice, { id, audio });
    pace.spokeAt = Date.now();
  };

  const goodbye = async (reason: "idle" | "dismissed" | "empty" | "ended" | "failed") => {
    await client.rooms.publish(roomId, EVENTS.gone, { reason }).catch(() => undefined);
    await client.rooms.leave(roomId).catch(() => undefined);
    log("left", { reason, lines: pace.spoken, woven: pace.woven, named: pace.named });
  };

  try {
    await speak(greetingPrompt(input.locale, input.by, guestsOf(members), camp));
    for (;;) {
      const page = await client.rooms.events(roomId, { after: cursor, waitMs: POLL_WAIT_MS, limit: 100 });
      cursor = page.cursor;
      const addressed: Heard[] = [];
      for (const event of page.events) {
        camp = reduce(camp, toCamp(event)).state;
        if (event.self) continue;
        if (event.type === EVENTS.dismiss) return await goodbye("dismissed");
        if (event.type !== EVENTS.chat) {
          if (event.type.startsWith("camp.")) pace.heardAt = Date.now();
          continue;
        }
        const chat = readChat(event.data);
        if (!chat) continue;
        const heard: Heard = { sequence: event.sequence, name: chat.name || "?", text: chat.text, toSpirit: chat.toSpirit === true, at: Date.now() };
        recent.push(heard);
        pace.heardAt = Date.now();
        if (heard.toSpirit) addressed.push(heard);
      }
      if (recent.length > 40) recent.splice(0, recent.length - 40);

      members = ((await client.rooms.get(roomId)).members ?? []) as Member[];
      const guests = guestsOf(members);
      if (guests.length === 0) return await goodbye("empty");

      const next = decide(pace, camp, addressed, woven, Date.now());
      if (!next) continue;
      switch (next.kind) {
        case "leave":
          return await goodbye(next.reason);
        case "reply":
          await speak(replyPrompt(input.locale, guests, camp, recent, next.lines, said));
          break;
        case "muse":
          await speak(musePrompt(input.locale, guests, camp, recent, said));
          break;
        case "name": {
          pace.actedAt = Date.now();
          await drift({ x: next.star.x, y: next.star.y + 70 });
          const label = tidyName(await think(namePrompt(input.locale, next.star), 40));
          if (label) {
            await client.rooms.publish(roomId, EVENTS.name, { id: next.star.id, name: label });
            pace.named += 1;
          }
          await drift({ x: FIRE.x + 150, y: FIRE.y + 50 });
          await setPresence(false);
          break;
        }
        case "weave": {
          pace.actedAt = Date.now();
          for (const card of next.sources) woven.add(card.id);
          const text = tidy(await think(weavePrompt(input.locale, next.sources), 160), 160);
          if (!text) break;
          const spot = weavePosition(next.sources, text);
          await drift({ x: spot.x + 108, y: spot.y + 120 });
          await client.rooms.publish(roomId, EVENTS.card, {
            id: createId(),
            text,
            x: spot.x,
            y: spot.y,
            by: { name, color: COLOR, spirit: true },
            sources: next.sources.map((card) => card.id),
          });
          pace.woven += 1;
          await setPresence(false);
          break;
        }
      }
      if (pace.spoken >= LIMITS.lines) return await goodbye("ended");
    }
  } catch (error) {
    log("failed", { message: (error as Error).message });
    await goodbye("failed");
    process.exitCode = 1;
  }
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  log("fatal", { message });
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
