import { applyMatrix, invertMatrix } from "@cohub/protocol/board-layout";
import { frameContainsPoint, type WorldPoint } from "./geometry.js";
import type { BoardScene, BoardSceneItem } from "./scene.js";
import type { BoardScriptOutput } from "./script.js";
import { scriptTemporaryPrefix } from "./script-scene.js";

export function boardScriptTarget(
  scene: BoardScene,
  candidates: readonly string[],
  point: WorldPoint,
  outputs: ReadonlyMap<string, BoardScriptOutput>,
  hitTest: (item: BoardSceneItem, point: WorldPoint) => boolean,
): { owner: string; target: string } | null {
  const owners = new Map(
    [...outputs.keys()].map((id) => [scriptTemporaryPrefix(id), id]),
  );
  for (const id of [...candidates].sort(
    (a, b) => scene.indexOf(b) - scene.indexOf(a),
  )) {
    const item = scene.get(id);
    if (
      !item ||
      scene.opacity(id) <= 0 ||
      (id.endsWith("root") && owners.has(id.slice(0, -4)))
    )
      continue;
    let parent = item.parent;
    let clipped = false;
    for (let depth = 0; parent && depth < 64; depth++) {
      const ancestor = scene.get(parent);
      if (!ancestor) break;
      if (
        ancestor.type === "frame" &&
        ancestor.props.clip &&
        !frameContainsPoint(ancestor.frame, point)
      ) {
        clipped = true;
        break;
      }
      parent = ancestor.parent;
    }
    if (clipped) continue;
    const output = outputs.get(id);
    if (output) {
      const local = applyMatrix(invertMatrix(scene.layout.matrix(id)), point);
      for (const [target, region] of Object.entries(output.hits).reverse()) {
        if (
          local.x >= region.x &&
          local.y >= region.y &&
          local.x <= region.x + region.width &&
          local.y <= region.y + region.height
        )
          return { owner: id, target };
      }
    }
    if (!hitTest(item, point)) continue;
    let current: BoardSceneItem | undefined = item;
    for (let depth = 0; current && depth < 64; depth++) {
      if (outputs.has(current.id)) return { owner: current.id, target: id };
      for (const [prefix, owner] of owners) {
        if (current.id === `${prefix}root`) break;
        if (current.id.startsWith(prefix))
          return { owner, target: current.id.slice(prefix.length) };
      }
      current = current.parent ? scene.get(current.parent) : undefined;
    }
    if (item.type === "frame" && item.props.decoration === "none") continue;
    return null;
  }
  return null;
}
