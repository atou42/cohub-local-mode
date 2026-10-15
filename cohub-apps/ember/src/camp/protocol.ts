
export const EVENTS = {
  card: "camp.card",
  move: "camp.move",
  burn: "camp.burn",
  ink: "camp.ink",
  wood: "camp.wood",
  name: "camp.name",
  chat: "camp.chat",
  snapshot: "camp.snapshot",
  summon: "spirit.summon",
  awake: "spirit.awake",
  speak: "spirit.speak",
  voice: "spirit.voice",
  dismiss: "spirit.dismiss",
  gone: "spirit.gone",
} as const;

export const SIGNALS = {
  pose: "camp.pose",
  stroke: "camp.stroke",
  drag: "camp.drag",
  wave: "camp.wave",
} as const;

export const LIMITS = {
  name: 24,
  cardText: 160,
  starName: 32,
  chat: 240,
  sources: 3,
  cards: 40,
  stars: 160,
  inks: 60,
  inkPoints: 96,
  glowingStars: 24,
} as const;

export const SPIRIT_ROLE = "spirit";
export const ROOM_MAX_PARTICIPANTS = 32;
export const WOOD_COOLDOWN_MS = 12_000;
export const LIVE_WINDOW_MS = 20_000;
export const SUMMON_WINDOW_MS = 75_000;

export type Author = { name: string; color: string; spirit?: boolean };
export type CardData = { id: string; text: string; x: number; y: number; by: Author; sources?: string[] };
export type MoveData = { id: string; x: number; y: number };
export type BurnData = { id: string };
export type InkData = { id: string; color: string; size: number; points: string };
export type WoodData = { name: string; x: number; y: number };
export type NameData = { id: string; name: string };
export type ChatData = { text: string; name: string; toSpirit?: boolean };
export type SnapshotData = { v: 1; key: string; upTo: number; part: number; parts: number; data: string };
export type SpeakData = { id: string; text: string; name: string };
export type VoiceData = { id: string; audio: string };
export type GoneData = { reason: "idle" | "dismissed" | "empty" | "ended" | "failed" };

export type CampEvent = { type: string; data: unknown; sequence: number; at: number };

const ID_RE = /^[A-Za-z0-9_]{4,32}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const WORLD_LIMIT = 4000;

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : null;

export const readId = (value: unknown) => (typeof value === "string" && ID_RE.test(value) ? value : null);
export const readColor = (value: unknown, fallback = "#f4a261") =>
  typeof value === "string" && COLOR_RE.test(value) ? value.toLowerCase() : fallback;
export const readNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= WORLD_LIMIT ? value : null;

const isControl = (char: string) => {
  const code = char.charCodeAt(0);
  return (code < 0x20 && char !== "\n" && char !== "\t") || code === 0x7f;
};

export const readText = (value: unknown, max: number) => {
  if (typeof value !== "string") return "";
  const chars = [...value].filter((char) => !isControl(char));
  return [...chars.join("").replace(/\n{3,}/g, "\n\n").trim()].slice(0, max).join("");
};

export const readAuthor = (value: unknown): Author | null => {
  const raw = record(value);
  const name = readText(raw?.name, LIMITS.name);
  if (!raw || !name) return null;
  return { name, color: readColor(raw.color), ...(raw.spirit === true ? { spirit: true } : {}) };
};

export const readCard = (value: unknown): CardData | null => {
  const raw = record(value);
  const id = readId(raw?.id);
  const text = readText(raw?.text, LIMITS.cardText);
  const x = readNumber(raw?.x);
  const y = readNumber(raw?.y);
  const by = readAuthor(raw?.by);
  if (!raw || !id || !text || x === null || y === null || !by) return null;
  const sources = Array.isArray(raw.sources)
    ? [...new Set(raw.sources.map(readId).filter((source): source is string => source !== null && source !== id))].slice(
        0,
        LIMITS.sources,
      )
    : [];
  return { id, text, x, y, by, ...(sources.length ? { sources } : {}) };
};

export const readMove = (value: unknown): MoveData | null => {
  const raw = record(value);
  const id = readId(raw?.id);
  const x = readNumber(raw?.x);
  const y = readNumber(raw?.y);
  return id && x !== null && y !== null ? { id, x, y } : null;
};

export const readBurn = (value: unknown): BurnData | null => {
  const id = readId(record(value)?.id);
  return id ? { id } : null;
};

export const readInk = (value: unknown): InkData | null => {
  const raw = record(value);
  const id = readId(raw?.id);
  const size = typeof raw?.size === "number" && Number.isFinite(raw.size) ? Math.min(14, Math.max(2, raw.size)) : null;
  if (!raw || !id || size === null || typeof raw.points !== "string" || raw.points.length > 4000) return null;
  return { id, color: readColor(raw.color), size, points: raw.points };
};

export const readWood = (value: unknown): WoodData => {
  const raw = record(value);
  return { name: readText(raw?.name, LIMITS.name), x: readNumber(raw?.x) ?? 0, y: readNumber(raw?.y) ?? 160 };
};

export const readName = (value: unknown): NameData | null => {
  const raw = record(value);
  const id = readId(raw?.id);
  const name = readText(raw?.name, LIMITS.starName).replace(/\s+/g, " ");
  return id && name ? { id, name } : null;
};

export const readChat = (value: unknown): ChatData | null => {
  const raw = record(value);
  const text = readText(raw?.text, LIMITS.chat);
  if (!raw || !text) return null;
  return { text, name: readText(raw.name, LIMITS.name), ...(raw.toSpirit === true ? { toSpirit: true } : {}) };
};

export const readSnapshot = (value: unknown): SnapshotData | null => {
  const raw = record(value);
  const key = readId(raw?.key);
  if (raw?.v !== 1 || typeof raw.data !== "string" || !key) return null;
  const { upTo, part, parts } = raw;
  if (![upTo, part, parts].every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0)) return null;
  if ((parts as number) < 1 || (parts as number) > 64 || (part as number) >= (parts as number)) return null;
  return { v: 1, key, upTo: upTo as number, part: part as number, parts: parts as number, data: raw.data };
};

const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export const createId = (random: () => number = Math.random) =>
  Array.from({ length: 10 }, () => ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)]).join("");
