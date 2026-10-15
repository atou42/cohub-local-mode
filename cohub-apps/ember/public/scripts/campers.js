
const MAX_CAST = 24;
const BUBBLE_MS = 7000;
const WISP_BUBBLE_MS = 11_000;
const POLL_MS = 100;

const rounded = (parent, x, y, width, height, fill, radius, alpha) => ({
  ...rect(parent, x, y, width, height, fill, alpha),
  props: { geometry: "rounded" },
  style: { fill, strokeWidth: 0, radius: radius || 3, fillOpacity: alpha === undefined ? 1 : alpha },
});

const shade = (hex, amount) => {
  if (typeof hex !== "string" || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const value = Number.parseInt(hex.slice(1), 16);
  const clamp = (channel) => Math.max(0, Math.min(255, Math.round(channel + amount)));
  const r = clamp((value >> 16) & 255);
  const g = clamp((value >> 8) & 255);
  const b = clamp(value & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
};

const rect = (parent, x, y, width, height, fill, alpha) => ({
  type: "shape",
  parent,
  position: { x: Math.round(x), y: Math.round(y) },
  size: { width: Math.round(width), height: Math.round(height) },
  props: { geometry: "rectangle" },
  style: { fill, strokeWidth: 0, fillOpacity: alpha === undefined ? 1 : alpha },
});

const ellipse = (parent, x, y, width, height, fill, alpha) => ({
  type: "shape",
  parent,
  position: { x: Math.round(x), y: Math.round(y) },
  size: { width: Math.round(width), height: Math.round(height) },
  props: { geometry: "ellipse" },
  style: { fill, strokeWidth: 0, fillOpacity: alpha === undefined ? 1 : alpha },
});

const ring = (parent, cx, cy, radius, stroke, alpha, width) => ({
  type: "shape",
  parent,
  position: { x: Math.round(cx - radius), y: Math.round(cy - radius) },
  size: { width: Math.round(radius * 2), height: Math.round(radius * 2) },
  props: { geometry: "ellipse" },
  style: { fill: "transparent", stroke, strokeWidth: width || 1.5, fillOpacity: alpha === undefined ? 1 : alpha },
});

export default function (ctx) {
  const s = ctx.state;
  s.cast = null;
  s.bubbles = {};
  s.poked = 0;
  s.pokedAt = 0;
  s.disposed = false;
  s.next = 0;
  s.hits = false;

  ctx.on("click", () => {
    s.poked = ctx.frame.t;
    s.pokedAt = performance.now();
    if (ctx.capabilities.has("camp.poke")) ctx.capabilities.call("camp.poke").catch(() => {});
  });
  ctx.onDispose(() => {
    s.disposed = true;
  });

  pump(ctx);
  ctx.onFrame(({ t }) => {
    if (t < s.next) return;
    const busy = isBusy(s);
    s.next = t + (busy ? 1000 / 30 : 1000 / 8);
    draw(ctx, t);
  });
}

async function pump(ctx) {
  let cursor = 0;
  while (!ctx.state.disposed) {
    try {
      const cast = await ctx.capabilities.call("camp.cast", { since: cursor });
      if (ctx.state.disposed) return;
      if (cast) {
        if (cast.z) ctx.state.cast = cast;
        for (const line of cast.chat || []) {
          if (typeof line.cursor === "number") cursor = Math.max(cursor, line.cursor);
          ctx.state.bubbles[line.id] = {
            text: String(line.text || "").slice(0, 120),
            name: String(line.name || ""),
            at: performance.now(),
            spirit: line.spirit === true,
            thinking: false,
          };
        }
      }
    } catch {
      await sleep(800);
    }
    await sleep(POLL_MS);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isBusy = (s) => {
  if (Object.keys(s.bubbles).length) return true;
  if (s.poked && performance.now() - s.pokedAt < 600) return true;
  const people = s.cast?.c || [];
  return people.some((entry) => (entry[4] & (1 | 8 | 16)) !== 0 || entry[7] === "s");
};

function draw(ctx, t) {
  const cast = ctx.state.cast;
  if (!cast) return;
  const zoom = Math.max(0.05, cast.z || 1);
  const boost = Math.min(2.2, Math.max(1, 0.95 / Math.sqrt(zoom)));
  const items = {};
  const pulse = ctx.state.poked ? Math.max(0, 1 - (t - ctx.state.poked) / 500) : 0;
  const people = (cast.c || []).slice(0, MAX_CAST).sort((a, b) => a[2] - b[2]);

  for (const entry of people) {
    const [id, x, y, phase, flags, level, name, key] = entry;
    const walking = (flags & 1) !== 0;
    const self = (flags & 2) !== 0;
    const left = (flags & 4) !== 0;
    const speaking = (flags & 8) !== 0;
    const thinking = (flags & 16) !== 0;
    const spirit = key === "s";
    const color = colorFor(key);
    const base = `a-${id}`;
    const bob = cast.reduced ? 0 : Math.sin(t / 720 + phase) * 0.9;
    const hop = pulse > 0 ? Math.sin((1 - pulse) * Math.PI) * 5 : 0;

    items[base] = {
      type: "frame",
      position: { x: x - 17 * boost, y: y - 46 * boost - bob - hop },
      size: { width: 34 * boost, height: 46 * boost },
      props: { decoration: "none", clip: false },
    };
    let layer = 0;
    const child = (item) => {
      layer += 1;
      return { ...item, parent: base, z: layer };
    };
    const px = (value) => value * boost;
    const turn = left ? -1 : 1;
    const blink = !cast.reduced && (t + phase * 900) % 3600 < 130;

    const step = walking && !cast.reduced ? Math.round(Math.sin(t / 110 + phase) * 2) : 0;
    items[`${base}-shadow`] = child(ellipse(0, px(8), px(40), px(24), px(6), "#02040a", 0.42));
    if (!spirit) {
      if (self) items[`${base}-self`] = child(ring(0, px(17), px(46), px(15), "#ffe2a6", 0.38, 1.2));
      items[`${base}-cape`] = child(rounded(0, px(8), px(16), px(18), px(22), color, 3));
      items[`${base}-hem`] = child(rounded(0, px(7), px(33 + step), px(20), px(5), shade(color, -44), 2));
      items[`${base}-fold`] = child(rect(0, px(left ? 20 : 11), px(18), px(3), px(20), shade(color, -30), 0.85));
      items[`${base}-hood`] = child(ellipse(0, px(7), px(5), px(20), px(16), shade(color, 18)));
      items[`${base}-face`] = child(rounded(0, px(11 + turn), px(10), px(12), px(7), "#faf3e0", 2));
      items[`${base}-eye-l`] = child(rect(0, px(13 + turn * 2), px(12), blink ? px(1) : px(2), blink ? px(1) : px(3), "#2a241c"));
      items[`${base}-eye-r`] = child(rect(0, px(19 + turn * 2), px(12), blink ? px(1) : px(2), blink ? px(1) : px(3), "#2a241c"));
      items[`${base}-foot-l`] = child(rect(0, px(12 - step), px(37), px(5), px(4), "#232a36"));
      items[`${base}-foot-r`] = child(rect(0, px(18 + step), px(37), px(5), px(4), "#232a36"));
    } else {
      const still = cast.reduced;
      const sway = still ? 0 : Math.sin(t / 340 + phase) * 2;
      const lift = still ? 0 : Math.sin(t / 900 + phase) * 4;
      items[`${base}-halo`] = child({
        type: "effect",
        position: { x: px(-20), y: px(-10 - lift) },
        size: { width: px(74), height: px(70) },
        props: { kind: "glow", life: 2200, intensity: 0.7 },
        style: { fill: color },
      });
      for (let index = 3; index >= 1; index -= 1) {
        const lag = still ? 0 : Math.sin((t - index * 140) / 340 + phase) * 2.4;
        const size = 9 - index * 2;
        items[`${base}-tail${index}`] = child(
          ellipse(0, px(17 - size / 2 + lag - (left ? -1 : 1) * index * 3), px(34 + index * 3 - lift), px(size), px(size), color, 0.6 - index * 0.14),
        );
      }
      items[`${base}-flame`] = child(ellipse(0, px(9 + sway), px(4 - lift), px(16), px(22), color, 0.82));
      items[`${base}-core`] = child(ellipse(0, px(10), px(10 - lift), px(14), px(22), "#effcff", 0.95));
      items[`${base}-eye-l`] = child(rect(0, px(13.5 + turn), px(18 - lift), blink ? px(1.5) : px(2.5), blink ? px(1) : px(4), "#16313d"));
      items[`${base}-eye-r`] = child(rect(0, px(18.5 + turn), px(18 - lift), blink ? px(1.5) : px(2.5), blink ? px(1) : px(4), "#16313d"));
    }
    if (speaking) items[`${base}-voice`] = child(ring(0, px(17), px(23), px(20 + level * 8), spirit ? color : "#ffe2a6", 0.22 + level * 0.5));
    if (thinking) {
      items[`${base}-think`] = child(rect(0, px(26), px(-3), px(4), px(4), "#a9c4e8", 0.85));
      items[`${base}-think2`] = child(rect(0, px(31), px(-9), px(3), px(3), "#a9c4e8", 0.6));
    }

    if (name && !spirit) {
      items[`${base}-name`] = {
        type: "text",
        parent: base,
        position: { x: px(17) - 50, y: px(47) },
        props: { text: name, fontSize: 10 * Math.min(1.6, boost), font: "Geist", width: 100, align: "center", fontWeight: 500 },
        style: { fill: self ? "#ffe2a6" : "#c3cee6" },
      };
    }

    const bubble = ctx.state.bubbles[id];
    if (bubble) {
      const age = performance.now() - bubble.at;
      const life = bubble.spirit ? WISP_BUBBLE_MS : BUBBLE_MS;
      if (age > life) delete ctx.state.bubbles[id];
      else {
        const box = bubbleBox(bubble.text);
        const fade = Math.min(1, (life - age) / 900, age / 160);
        const rise = Math.min(1, age / 220);
        const holder = `${base}-bubble`;
        items[holder] = {
          type: "frame",
          parent: base,
          position: { x: px(17) - box.width / 2, y: -box.height - 14 - ((flags & 32) !== 0 ? 90 / zoom : 0) - (1 - rise) * 6 },
          size: { width: box.width, height: box.height },
          opacity: Math.max(0, fade),
          props: { decoration: "none", clip: false },
        };
        items[`${holder}-plate`] = {
          type: "shape",
          parent: holder,
          z: 1,
          size: { width: box.width, height: box.height },
          props: { geometry: "rounded" },
          style: { fill: "#141a26", stroke: bubble.spirit ? "#5aa9c8" : "#3a4356", strokeWidth: 1, radius: 10, fillOpacity: 0.95 },
        };
        items[`${holder}-tail`] = {
          type: "shape",
          parent: holder,
          z: 0,
          position: { x: box.width / 2 - 6, y: box.height - 7 },
          size: { width: 12, height: 12 },
          props: { geometry: "diamond" },
          style: { fill: "#141a26", stroke: bubble.spirit ? "#5aa9c8" : "#3a4356", strokeWidth: 1, fillOpacity: 0.95 },
        };
        items[`${holder}-text`] = {
          type: "text",
          parent: holder,
          z: 2,
          position: { x: BUBBLE_PAD, y: BUBBLE_PAD - 2 },
          props: { text: bubble.text, fontSize: BUBBLE_FONT, lineHeight: BUBBLE_LINE, width: box.width - BUBBLE_PAD * 2, font: "Geist" },
          style: { fill: bubble.spirit ? "#dff6ff" : "#eaeffb" },
        };
      }
    }
  }

  for (const id of Object.keys(ctx.state.bubbles)) {
    if (!people.some((entry) => entry[0] === id) && performance.now() - ctx.state.bubbles[id].at > 1500) delete ctx.state.bubbles[id];
  }
  ctx.scene(items);
  const me = Boolean(items["a-me"]);
  if (me !== ctx.state.hits) {
    ctx.state.hits = me;
    ctx.hitRegions(me ? { me: { item: "a-me", label: String(ctx.params.wave || "Wave"), cursor: "pointer" } } : {});
  }
}

const BUBBLE_FONT = 13;
const BUBBLE_LINE = 1.4;
const BUBBLE_PAD = 10;
const BUBBLE_MAX = 240;

const bubbleBox = (text) => {
  let units = 0;
  for (const char of String(text)) units += char.charCodeAt(0) > 0x2e80 ? 1 : 0.56;
  const natural = units * BUBBLE_FONT;
  const inner = Math.min(BUBBLE_MAX - BUBBLE_PAD * 2, Math.max(60, natural + 12));
  const lines = Math.max(1, Math.ceil((natural * 1.15) / Math.max(1, inner - 4)));
  return { width: Math.ceil(inner + BUBBLE_PAD * 2), height: Math.ceil(lines * BUBBLE_FONT * BUBBLE_LINE + BUBBLE_PAD * 2 - 2) };
};

const colorFor = (key) => (key === "s" ? "#8fe7ff" : typeof key === "string" && /^#[0-9a-f]{6}$/i.test(key) ? key : "#f4a261");
