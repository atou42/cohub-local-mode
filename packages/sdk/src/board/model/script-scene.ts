import {
  applyBoardPatchToDocument,
  mergePatch,
} from "@cohub/protocol/board-patch";
import {
  parseBoardItem as parseItem,
  type BoardDocument,
  type BoardItem,
  type BoardPatch,
} from "@cohub/protocol/board-model";
import type { BoardScriptOutput } from "./script.js";
import { applyMatrix, createBoardLayout } from "@cohub/protocol/board-layout";
import type { BoardScene } from "./scene.js";

function parseBoardItem(value: unknown): BoardItem {
  const parsed = parseItem(value);
  if (!parsed.ok)
    throw new Error(parsed.diagnostics[0]?.message ?? "Invalid script item.");
  return parsed.item;
}

const DISPLAY_FIELDS = new Set([
  "position",
  "size",
  "rotation",
  "scale",
  "opacity",
  "style",
  "props",
]);

export function boardScriptScope(
  document: Pick<BoardDocument, "items">,
  id: string,
): Set<string> {
  const scope = new Set([
    id,
    ...Object.values(document.items[id]?.script?.targets ?? {}).filter(
      (target) => Boolean(document.items[target]),
    ),
  ]);
  if (document.items[id]?.type !== "frame") return scope;
  for (const candidate of Object.keys(document.items)) {
    let parent = document.items[candidate]?.parent;
    for (let depth = 0; parent && depth < 64; depth++) {
      if (parent === id) {
        scope.add(candidate);
        break;
      }
      parent = document.items[parent]?.parent;
    }
  }
  return scope;
}

export function validateBoardScriptOutput(
  output: BoardScriptOutput,
  scope: ReadonlySet<string>,
): void {
  if (
    !output ||
    typeof output !== "object" ||
    !output.patches ||
    !output.items ||
    !output.hits ||
    !Array.isArray(output.listens)
  )
    throw new Error("Invalid script output.");
  if (JSON.stringify(output).length > 1_000_000)
    throw new Error("Script output exceeds the 1 MB limit.");
  if (
    output.space !== undefined &&
    output.space !== "world" &&
    output.space !== "screen"
  )
    throw new Error("Invalid script scene space.");
  if (output.anchor) {
    const { item, point } = output.anchor;
    if (output.space !== "screen" || typeof item !== "string" || !item ||
        (point && ![point.x, point.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)))
      throw new Error("Invalid screen scene anchor.");
  }
  if (output.parameters) {
    if (Object.keys(output.parameters).length > 64)
      throw new Error("A script may declare at most 64 parameters.");
    for (const spec of Object.values(output.parameters)) {
      if (
        !spec ||
        !["number", "boolean", "string", "color"].includes(spec.type)
      )
        throw new Error("Invalid script parameter type.");
      if (spec.label !== undefined && typeof spec.label !== "string")
        throw new Error("Invalid script parameter label.");
      if (
        [spec.min, spec.max, spec.step].some(
          (value) => value !== undefined && !Number.isFinite(value),
        )
      )
        throw new Error("Invalid script parameter range.");
    }
  }
  if (
    Object.keys(output.items).length > 1000 ||
    Object.keys(output.hits).length > 1000
  )
    throw new Error(
      "A script may create at most 1000 temporary items or hit regions.",
    );
  for (const [id, patch] of Object.entries(output.patches)) {
    if (!scope.has(id))
      throw new Error(`Item is outside the script scope: ${id}`);
    if (
      !patch ||
      typeof patch !== "object" ||
      Object.keys(patch).some((key) => !DISPLAY_FIELDS.has(key))
    )
      throw new Error("Scripts may only present display properties.");
  }
  for (const hit of Object.values(output.hits)) {
    if (!hit || typeof hit !== "object") throw new Error("Invalid script hit region.");
    if (
      hit.cursor &&
      ![
        "default",
        "pointer",
        "grab",
        "grabbing",
        "crosshair",
        "text",
        "move",
        "ew-resize",
        "ns-resize",
        "not-allowed",
      ].includes(hit.cursor)
    )
      throw new Error("Invalid script cursor.");
    if ("target" in hit) {
      if (hit.target !== "self" || "item" in hit || "x" in hit) throw new Error("Invalid script hit target.");
    } else if ("item" in hit) {
      if (typeof hit.item !== "string" || !Object.hasOwn(output.items, hit.item) || "x" in hit)
        throw new Error("Hit items must belong to the temporary scene.");
    } else if (
      ![hit.x, hit.y, hit.width, hit.height].every(Number.isFinite) ||
      hit.width < 0 || hit.height < 0
    ) throw new Error("Invalid script hit region.");
  }
}

export function validateBoardScriptCommit(
  document: BoardDocument,
  id: string,
  patch: BoardPatch,
): void {
  if (
    !patch ||
    typeof patch !== "object" ||
    Object.keys(patch).some((key) => key !== "items")
  )
    throw new Error("Scripts may only commit items in their scope.");
  const scope = boardScriptScope(document, id);
  for (const [target, value] of Object.entries(patch.items ?? {})) {
    if (!scope.has(target)) {
      if (document.items[target])
        throw new Error(`Item is outside the script scope: ${target}`);
      if (
        !value ||
        typeof value !== "object" ||
        !("parent" in value) ||
        typeof value.parent !== "string" ||
        !scope.has(value.parent) ||
        document.items[value.parent]?.type !== "frame"
      )
        throw new Error(
          "New items must belong to a frame in the script scope.",
        );
      if ("script" in value)
        throw new Error("Scripts cannot start other scripts.");
      continue;
    }
    if (
      value &&
      typeof value === "object" &&
      ("script" in value || "parent" in value || "type" in value)
    )
      throw new Error(
        "A script cannot replace scripts, types, or parent relationships.",
      );
  }
  const result = applyBoardPatchToDocument(document, patch);
  if (!result.ok)
    throw new Error(result.diagnostics[0]?.message ?? "Invalid script commit.");
}

export function scriptTemporaryPrefix(owner: string): string {
  let hash = 2166136261;
  for (const char of owner)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return `~script-${hash.toString(36)}-`;
}

type PreparedOutput = {
  document: BoardDocument;
  owner: string;
  rootId: string;
  items: Map<string, BoardItem>;
  presented: Map<string, { base: BoardItem; item: BoardItem }>;
};
const preparedOutputs = new WeakMap<BoardScriptOutput, PreparedOutput>();
const preparedScopes = new WeakMap<BoardDocument, Map<string, Set<string>>>();
const itemOrders = new WeakMap<BoardDocument["items"], Map<string, number>>();

function orderedScriptOwners(document: BoardDocument, outputs: ReadonlyMap<string, BoardScriptOutput>): string[] {
  let order = itemOrders.get(document.items);
  if (!order) {
    order = new Map(Object.keys(document.items).map((id, index) => [id, index]));
    itemOrders.set(document.items, order);
  }
  return [...outputs.keys()].filter(id => order.has(id)).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

export function prepareBoardScriptOutput(
  document: BoardDocument,
  owner: string,
  output: BoardScriptOutput,
): PreparedOutput {
  const previous = preparedOutputs.get(output);
  if (previous?.document === document && previous.owner === owner)
    return previous;
  let scopes = preparedScopes.get(document);
  if (!scopes) {
    scopes = new Map();
    preparedScopes.set(document, scopes);
  }
  let scope = scopes.get(owner);
  if (!scope) {
    scope = boardScriptScope(document, owner);
    scopes.set(owner, scope);
  }
  if (output.anchor && document.items[output.anchor.item] && !scope.has(output.anchor.item))
    throw new Error("Scene anchor is outside the script scope.");
  validateBoardScriptOutput(output, scope);
  const presented = new Map<string, { base: BoardItem; item: BoardItem }>();
  for (const [id, patch] of Object.entries(output.patches)) {
    const base = document.items[id];
    if (base)
      presented.set(id, {
        base,
        item: parseBoardItem(mergePatch(base, patch)),
      });
  }
  const prefix = scriptTemporaryPrefix(owner);
  const rootId = `${prefix}root`;
  if (document.items[rootId])
    throw new Error("Temporary item ID conflicts with the document.");
  const items = new Map<string, BoardItem>();
  const parsed = new Map(
    Object.entries(output.items).map(([id, value]) => [
      id,
      parseBoardItem(value),
    ]),
  );
  for (const [local, value] of parsed) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(local) || local === "root")
      throw new Error(
        "Temporary IDs must be 1–80 letters, digits, underscores or hyphens; root is reserved.",
      );
    if (value.script) throw new Error("Temporary items cannot start scripts.");
    if (value.parent && !(value.parent in output.items))
      throw new Error("Temporary parents must belong to the same instance.");
    let cursor = value.parent;
    const visited = new Set([local]);
    while (cursor) {
      if (visited.has(cursor))
        throw new Error("Temporary parents must not form a cycle.");
      visited.add(cursor);
      const parentItem = parsed.get(cursor);
      if (!parentItem) throw new Error("Temporary parent is missing.");
      if (parentItem.type !== "frame")
        throw new Error("Only frames can contain temporary items.");
      cursor = parentItem.parent;
    }
    const id = `${prefix}${local}`;
    if (document.items[id])
      throw new Error("Temporary item ID conflicts with the document.");
    const parent = value.parent ? `${prefix}${value.parent}` : rootId;
    if (value.type === "arrow") {
      const remap = (endpoint: typeof value.props.start) => {
        if (!("item" in endpoint)) return endpoint;
        if (!(endpoint.item in output.items) && !scope.has(endpoint.item))
          throw new Error("Arrow target is outside the script scope.");
        return endpoint.item in output.items
          ? { ...endpoint, item: `${prefix}${endpoint.item}` }
          : endpoint;
      };
      items.set(id, {
        ...value,
        parent,
        props: {
          ...value.props,
          start: remap(value.props.start),
          end: remap(value.props.end),
        },
      });
    } else items.set(id, { ...value, parent });
  }
  const prepared = { document, owner, rootId, items, presented };
  preparedOutputs.set(output, prepared);
  return prepared;
}

export function composeBoardScriptItems(
  document: BoardDocument,
  scene: BoardScene,
  outputs: ReadonlyMap<string, BoardScriptOutput>,
  incoming: ReadonlyMap<string, BoardItem> = new Map(),
  screen?: { zoom: number },
  onError?: (owner: string, error: unknown) => void,
  gestureLayout?: BoardScene["layout"],
): Map<string, BoardItem> {
  const result = new Map(incoming);
  const screenAnchors = new Map<string, string>();
  if (outputs.size === 0) return result;
  for (const owner of orderedScriptOwners(document, outputs)) {
    const output = outputs.get(owner);
    if (!output) continue;
    try {
      const changes = new Map<string, BoardItem>();
      const prepared = prepareBoardScriptOutput(document, owner, output);
      for (const [id, patch] of Object.entries(output.patches)) {
        const base = result.get(id) ?? document.items[id];
        if (!base) continue;
        let cached = prepared.presented.get(id);
        if (cached?.base !== base) {
          cached = { base, item: parseBoardItem(mergePatch(base, patch)) };
          prepared.presented.set(id, cached);
        }
        changes.set(id, cached.item);
      }
      if (!prepared.items.size || (output.space === "screen" && !screen)) {
        for (const [id, item] of changes) result.set(id, item);
        continue;
      }
      const rootId = prepared.rootId;
      const item =
        changes.get(owner) ?? result.get(owner) ?? document.items[owner];
      if (!item) continue;
      const box = scene.layout.box(owner);
      const overlay =
        output.space === "screen" && screen
          ? {
              parent: undefined,
              position: { x: 0, y: 0 },
              scale: 1 / screen.zoom,
              rotation: 0,
              origin: { x: 0, y: 0 },
            }
          : {};
      changes.set(
        rootId,
        parseBoardItem({
          type: "frame",
          parent: item.parent,
          position: item.position,
          rotation: item.rotation,
          scale: item.scale,
          origin: item.origin,
          opacity: item.opacity,
          size: {
            width: Math.max(1, box.width),
            height: Math.max(1, box.height),
          },
          z: (item.z ?? 0) + 0.001,
          props: { decoration: "none", clip: false },
          ...overlay,
        }),
      );
      for (const [id, value] of prepared.items) changes.set(id, value);
      for (const [id, item] of changes) result.set(id, item);
      if (output.space === "screen") screenAnchors.set(owner, rootId);
    } catch (error) {
      if (!onError) throw error;
      onError(owner, error);
    }
  }
  if (screenAnchors.size) {
    const layout = gestureLayout ?? createBoardLayout(
      (id) => result.get(id) ?? document.items[id],
    );
    for (const [owner, rootId] of screenAnchors) {
      const root = result.get(rootId);
      const anchor = outputs.get(owner)?.anchor;
      const target = anchor?.item ?? owner;
      const exists = Boolean(document.items[target]);
      const box = exists ? layout.box(target) : { width: 0, height: 0 };
      if (root)
        result.set(rootId, {
          ...root,
          opacity: exists ? root.opacity : 0,
          position: exists ? applyMatrix(layout.matrix(target), {
            x: (anchor?.point?.x ?? 0) * box.width,
            y: (anchor?.point?.y ?? 0) * box.height,
          }) : root.position,
        });
    }
  }
  return result;
}
