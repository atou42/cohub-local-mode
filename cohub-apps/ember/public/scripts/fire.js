
export default function (ctx) {
  const s = ctx.state;
  s.heat = 0.5;
  s.shown = -1;
  s.hot = false;
  s.disposed = false;
  s.flames = 1;
  s.scale = 1;
  s.glow = 1;

  ctx.hitRegions({ fire: { target: "self", label: String(ctx.params.label || "Fire"), cursor: "pointer" } });
  ctx.on("click", () => {
    if (ctx.capabilities.has("camp.feed")) ctx.capabilities.call("camp.feed").catch(() => {});
  });
  ctx.onDispose(() => {
    s.disposed = true;
  });

  pump(ctx);
  ctx.onFrame(({ t, dt }) => {
    const flames = 1 + (s.heat - 0.5) * 0.55 + (s.hot ? 0.16 : 0) + Math.sin(t / 210) * 0.02 * (0.4 + s.heat);
    const scale = 1 + (s.heat - 0.5) * 0.5 + (s.hot ? 0.06 : 0);
    const glow = 0.78 + s.heat * 0.6 + (s.hot ? 0.15 : 0) + Math.sin(t / 1300) * 0.02;
    const step = Math.min(1, dt / 90);
    s.flames += (flames - s.flames) * step;
    s.scale += (scale - s.scale) * step;
    s.glow += (glow - s.glow) * step;
    if (Math.abs(s.shown - s.scale) < 0.004 && Math.abs((s.shownGlow ?? 0) - s.glow) < 0.01) return;
    s.shown = s.scale;
    s.shownGlow = s.glow;
    ctx.self.present({ scale: s.scale });
    ctx.present("fire-light", { scale: s.glow });
  });
}

async function pump(ctx) {
  while (!ctx.state.disposed) {
    try {
      const fire = await ctx.capabilities.call("camp.fire");
      if (ctx.state.disposed) return;
      if (fire) {
        const heat = typeof fire.heat === "number" ? Math.max(0, Math.min(1, fire.heat)) : 0.5;
        ctx.state.heat = heat;
        ctx.state.hot = fire.hot === true;
        ctx.state.flames = 1 + (heat - 0.5) * 0.55 + (fire.hot ? 0.16 : 0);
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
