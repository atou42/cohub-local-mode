export type BoardScriptPointerTarget = { owner: string; target: string };
type Gesture = {
  target: BoardScriptPointerTarget | null;
  x: number;
  y: number;
};

export function createBoardScriptPointerRouter() {
  const gestures = new Map<number, Gesture>();
  return {
    needsRouting(pointerId: number, scriptsEnabled: boolean): boolean {
      return scriptsEnabled || gestures.has(pointerId);
    },
    owner(pointerId: number): "editor" | "script" | null {
      const gesture = gestures.get(pointerId);
      return gesture ? (gesture.target ? "script" : "editor") : null;
    },
    route(
      phase: "down" | "move" | "up" | "leave",
      pointerId: number,
      target: BoardScriptPointerTarget | null,
      point: { x: number; y: number },
      cancelled = false,
    ): {
      recipient: BoardScriptPointerTarget | null;
      click: BoardScriptPointerTarget | null;
    } {
      if (phase === "down") gestures.set(pointerId, { target, ...point });
      const gesture = gestures.get(pointerId);
      const recipient = gesture
        ? gesture.target
        : phase === "move"
          ? target
          : null;
      let click: BoardScriptPointerTarget | null = null;
      if (phase === "up") {
        gestures.delete(pointerId);
        if (
          !cancelled &&
          gesture?.target &&
          target?.owner === gesture.target.owner &&
          target.target === gesture.target.target &&
          Math.hypot(point.x - gesture.x, point.y - gesture.y) < 5
        )
          click = gesture.target;
      }
      return { recipient, click };
    },
    clear() {
      gestures.clear();
    },
  };
}
