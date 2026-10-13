import type { BoardDocument, BoardItem } from "@cohub/protocol";

const scriptsByItems = new WeakMap<BoardDocument["items"], readonly (readonly [string, BoardItem])[]>();

export function boardScriptItems(document: Pick<BoardDocument, "items">): readonly (readonly [string, BoardItem])[] {
  let scripts = scriptsByItems.get(document.items);
  if (!scripts) {
    scripts = Object.entries(document.items).filter(([, item]) => item.script?.enabled);
    scriptsByItems.set(document.items, scripts);
  }
  return scripts;
}

export function hasBoardScripts(document: Pick<BoardDocument, "items">): boolean {
  return boardScriptItems(document).length > 0;
}
