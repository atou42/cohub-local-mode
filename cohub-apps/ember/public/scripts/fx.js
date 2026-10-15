
const WOOD_MS = 900;
const SPARK_MS = 1500;
const WAVE_MS = 1100;
const MAX_EFFECTS = 12;

export default function (ctx) {
  const state = ctx.state;
  state.effects = [];
  state.painted = false;
  state.disposed = false;
  ctx.onDispose(() => {
    state.disposed = true;
  });
  pump(ctx);

  ctx.onFrame(({ t }) => {
    const effects = state.effects;
    if (!effects.length) {
      if (state.painted) {
        state.painted = false;
        ctx.scene({});
      }
      return;
    }
    const items = {};
    const now = performance.now();
    const alive = [];
    for (const effect of effects) {
      const age = now - effect.born;
      if (age > (effect.life || SPARK_MS)) continue;
      alive.push(effect);
      if (age >= 0) paint(items, effect, age, t, alive.length);
    }
    state.effects = alive;
    state.painted = true;
    ctx.scene(items);
  });
}

async function pump(ctx) {
  let cursor = 0;
  while (!ctx.state.disposed) {
    try {
      const result = await ctx.capabilities.call("camp.fx", { since: cursor });
      if (ctx.state.disposed) return;
      if (result) {
        cursor = result.cursor;
        const now = performance.now();
        for (const effect of result.effects) ctx.state.effects.push({ ...effect, born: now - effect.age });
        if (ctx.state.effects.length > MAX_EFFECTS) ctx.state.effects.splice(0, ctx.state.effects.length - MAX_EFFECTS);
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    await new Promise((resolve) => setTimeout(resolve, ctx.state.effects.length ? 60 : 140));
  }
}

function paint(items, effect, age, t, index) {
  const u = age / (effect.life || SPARK_MS);
  const scope = (local) => `${effect.id}-${local}`;
  const into = {};
  switch (effect.kind) {
    case "burn":
      burn(into, effect, age);
      break;
    case "spark":
      spark(into, effect, age);
      break;
    case "arrive":
      arrive(into, effect, u);
      break;
    case "wood":
      wood(into, effect, age / WOOD_MS, t);
      break;
    case "wave":
      wave(into, effect, age / WAVE_MS);
      break;
    case "puff":
      puff(into, effect, u);
      break;
    default:
      return;
  }
  for (const [id, item] of Object.entries(into)) {
    items[scope(id)] = item.parent ? { ...item, parent: scope(item.parent), z: index } : { ...item, z: index };
  }
}

const ease = (value) => value * value * (3 - 2 * value);

function burn(items, effect, age) {
  const progress = ease(Math.min(1, age / Math.max(1, effect.life * 0.86)));
  const x = effect.from.x + (effect.to.x - effect.from.x) * progress;
  const y = effect.from.y + (effect.to.y - effect.from.y) * progress - Math.sin(progress * Math.PI) * 130;
  const shrink = Math.max(0.08, 1 - progress * 0.92);
  const width = Math.max(14, effect.width * shrink);
  const height = Math.max(10, effect.height * shrink);
  items.card = {
    type: "frame",
    position: { x: x - width / 2, y: y - height / 2 },
    size: { width, height },
    rotation: progress * 26,
    opacity: Math.max(0, 1 - progress * 1.05),
    props: { decoration: "none", clip: false },
  };
  items.cardPaper = {
    type: "shape",
    parent: "card",
    size: { width, height },
    props: { geometry: "rounded" },
    style: { fill: "#efe5cf", stroke: "#f0a04b", strokeWidth: 1.5, radius: 4 },
  };
  const sparks = Math.round(10 * progress) + 4;
  for (let index = 0; index < sparks; index += 1) {
    const angle = (index / sparks) * Math.PI * 2 + progress * 3;
    const distance = 12 + progress * 46 * (0.6 + (index % 3) * 0.2);
    items[`s${index}`] = dot(
      x + Math.cos(angle) * distance,
      y + Math.sin(angle) * distance - Math.sin(progress * Math.PI) * 30,
      2 + (index % 3),
      age,
    );
  }
  return undefined;
}

function spark(items, effect, age) {
  const middle = 0.78;
  const travel = ease(Math.min(1, age / (effect.life * middle)));
  const fall = age > effect.life * middle ? Math.min(1, (age - effect.life * middle) / (effect.life * (1 - middle))) : 0;
  const x = effect.from.x + (effect.to.x - effect.from.x) * travel;
  const y = effect.from.y + (effect.to.y - effect.from.y) * travel - Math.sin(travel * Math.PI) * 220;
  const tail = 9;
  for (let index = 0; index < tail; index += 1) {
    const back = Math.max(0, travel - index * 0.035);
    const px = effect.from.x + (effect.to.x - effect.from.x) * back;
    const py = effect.from.y + (effect.to.y - effect.from.y) * back - Math.sin(back * Math.PI) * 220;
    const fade = (1 - index / tail) * (1 - fall) * 0.8;
    if (fade <= 0.02) continue;
    const size = (index === 0 ? 7 : Math.max(1.5, 6 - index * 0.45)) * (1 - fall * 0.5);
    items[`t${index}`] = {
      type: "shape",
      position: { x: px - size / 2, y: py - size / 2 },
      size: { width: size, height: size },
      props: { geometry: "ellipse" },
      style: { fill: index === 0 ? "#fff6de" : "#ffd27a", strokeWidth: 0, fillOpacity: fade },
    };
  }
  if (fall > 0) items.ring = ring(x, y, 10 + fall * 54, 1 - fall, "#ffe2a6", 2.4 * (1 - fall));
  return undefined;
}

function arrive(items, effect, progress) {
  const fade = 1 - progress;
  items.halo = ring(effect.to.x, effect.to.y, 8 + progress * 40, fade * 0.9, "#fff6de", 2);
  for (let index = 0; index < 6; index += 1) {
    const angle = (index / 6) * Math.PI * 2 + progress * 1.4;
    const distance = 6 + progress * 34;
    items[`a${index}`] = dot(effect.to.x + Math.cos(angle) * distance, effect.to.y + Math.sin(angle) * distance, 2.5, progress * 10 + index);
  }
  return undefined;
}

function wood(items, effect, progress, t) {
  const clamped = Math.min(1, Math.max(0, progress));
  const height = 120;
  const x = effect.from.x + (effect.to.x - effect.from.x) * clamped;
  const y = effect.from.y + (effect.to.y - effect.from.y) * clamped - Math.sin(clamped * Math.PI) * height;
  const spin = clamped * 220;
  items.log = {
    type: "frame",
    position: { x: x - 20, y: y - 6 },
    size: { width: 40, height: 12 },
    rotation: spin,
    opacity: clamped > 0.88 ? Math.max(0, 1 - (clamped - 0.88) / 0.12) : 1,
    props: { decoration: "none", clip: false },
  };
  items.logBody = {
    type: "shape",
    parent: "log",
    size: { width: 40, height: 12 },
    props: { geometry: "rounded" },
    style: { fill: "#6b4326", strokeWidth: 0, radius: 5 },
  };
  items.logEye = {
    type: "shape",
    parent: "log",
    position: { x: 30, y: 4 },
    size: { width: 6, height: 4 },
    props: { geometry: "ellipse" },
    style: { fill: "#c98a5b", strokeWidth: 0 },
  };
  if (clamped > 0.4) {
    for (let index = 0; index < 8; index += 1) {
      const age = clamped - 0.4;
      items[`w${index}`] = dot(effect.to.x + Math.sin(t / 300 + index) * 12, effect.to.y - 10 - age * 60 - index * 4, 2, index * 3);
    }
  }
  return undefined;
}

function wave(items, effect, progress) {
  const rise = Math.min(1, Math.max(0, progress));
  const fade = 1 - rise;
  items.glyph = {
    type: "text",
    position: { x: effect.from.x - 40, y: effect.from.y - 40 - rise * 40 },
    opacity: fade,
    props: { text: effect.glyph || "✦", fontSize: 16 + rise * 6, width: 80, align: "center", font: "Geist" },
    style: { fill: "#ffe2a6" },
  };
  return undefined;
}

function puff(items, effect, progress) {
  items.puff = ring(effect.from.x, effect.from.y, 6 + progress * 26, (1 - progress) * 0.7, "#c9d3ff", 1.6);
  return undefined;
}

const dot = (x, y, size, seed) => ({
  type: "shape",
  position: { x: x - size / 2 + (seed % 3) - 1, y: y - size / 2 + (seed % 2) - 0.5 },
  size: { width: size, height: size },
  props: { geometry: "ellipse" },
  style: { fill: "#ffd27a", strokeWidth: 0 },
});

const ring = (x, y, radius, alpha, stroke, width) => ({
  type: "shape",
  position: { x: x - radius, y: y - radius },
  size: { width: radius * 2, height: radius * 2 },
  props: { geometry: "ellipse" },
  style: { fill: "transparent", stroke, strokeWidth: width || 2, fillOpacity: Math.max(0, alpha) },
});
