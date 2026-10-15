
export type Point = { x: number; y: number };

export const FIRE: Point = { x: 0, y: 0 };
export const BURN_RADIUS = 150;
const FIRE_CLEARANCE = 92;
export const MEADOW = { cx: 0, cy: 70, rx: 1080, ry: 690 } as const;
const WALK = { cx: 0, cy: 70, rx: 960, ry: 600 } as const;
export const SKY = { x: -1500, y: -1820, width: 3000, height: 860 } as const;
export const SPAWN: Point = { x: 0, y: 230 };

export const WALK_SPEED = 320;
const WHISPER = 150;
export const EARSHOT = 780;

export const CARD_WIDTH = 216;

const HALF_LIFE_MS = 6 * 60_000;
const EMBER_HORIZON_MS = HALF_LIFE_MS * 8;

export type Ember = { at: number; w: number };

export const heatAt = (embers: readonly Ember[], now: number) => {
  let heat = 0;
  for (const ember of embers) {
    const age = now - ember.at;
    if (age >= 0) heat += ember.w * 2 ** (-age / HALF_LIFE_MS);
  }
  return heat;
};

export const pruneEmbers = (embers: readonly Ember[], now: number) =>
  embers.filter((ember) => now - ember.at < EMBER_HORIZON_MS).slice(-200);

const glow = (heat: number) => 1 - Math.exp(-Math.max(0, heat) / 2.4);
export const fireScale = (heat: number) => 0.8 + 0.55 * glow(heat);
export const hearthRadius = (heat: number) => 250 + 230 * glow(heat);

const clampToEllipse = (point: Point, ellipse: { cx: number; cy: number; rx: number; ry: number }): Point => {
  const dx = point.x - ellipse.cx;
  const dy = point.y - ellipse.cy;
  const k = (dx / ellipse.rx) ** 2 + (dy / ellipse.ry) ** 2;
  if (k <= 1) return point;
  const s = 1 / Math.sqrt(k);
  return { x: ellipse.cx + dx * s, y: ellipse.cy + dy * s };
};

export const walkable = (point: Point): Point => {
  const inside = clampToEllipse(point, WALK);
  const dx = inside.x - FIRE.x;
  const dy = inside.y - FIRE.y;
  const d = Math.hypot(dx, dy);
  if (d >= FIRE_CLEARANCE) return inside;
  if (d < 0.001) return { x: FIRE.x, y: FIRE.y + FIRE_CLEARANCE };
  return { x: FIRE.x + (dx / d) * FIRE_CLEARANCE, y: FIRE.y + (dy / d) * FIRE_CLEARANCE };
};

export const hearingDistance = (listener: Point, speaker: Point, hearth: number) =>
  Math.hypot(listener.x - FIRE.x, listener.y - FIRE.y) <= hearth && Math.hypot(speaker.x - FIRE.x, speaker.y - FIRE.y) <= hearth
    ? 0
    : Math.hypot(speaker.x - listener.x, speaker.y - listener.y);

export const voiceVolume = (distance: number) => {
  if (distance <= WHISPER) return 1;
  if (distance >= EARSHOT) return 0;
  const t = 1 - (distance - WHISPER) / (EARSHOT - WHISPER);
  return t * t;
};

export const hash = (value: string) => {
  let h = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

export const seeded = (seed: string) => {
  let state = hash(seed) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const STAR_GAP = 78;

export const placeStar = (id: string, taken: Iterable<Point>): Point => {
  const random = seeded(`star:${id}`);
  const others = [...taken];
  let spot: Point = { x: 0, y: SKY.y + SKY.height / 2 };
  for (let attempt = 0; attempt < 32; attempt += 1) {
    spot = { x: Math.round(SKY.x + random() * SKY.width), y: Math.round(SKY.y + random() * SKY.height) };
    if (others.every((other) => Math.hypot(other.x - spot.x, other.y - spot.y) >= STAR_GAP)) return spot;
  }
  return spot;
};

const textWidthUnits = (text: string) => {
  let units = 0;
  for (const char of text) units += /[\u1100-\uffff]/.test(char) ? 2 : 1;
  return units;
};

export const cardHeight = (text: string) => {
  const lines = text
    .split("\n")
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(textWidthUnits(line) / 26)), 0);
  return Math.round(Math.min(300, 82 + lines * 21));
};
