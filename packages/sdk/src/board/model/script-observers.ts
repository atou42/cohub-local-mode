import type { BoardDocument } from "@cohub/protocol";
import { boardScriptScope } from "./script-scene.js";
import type { BoardScriptEvent, BoardScriptOutput, BoardScriptView } from "./script.js";

const EVENTS = ["viewchange", "selectionchange", "transformend"] as const;
type Subscription = {
  listens: Set<string>;
  document?: BoardDocument;
  scope: ReadonlySet<string>;
  selection?: readonly string[];
  selected?: string[];
  view?: string;
};

export function createBoardScriptObservers(send: (owner: string, event: BoardScriptEvent) => void) {
  const subscribers = new Map<string, Subscription>();
  function scope(owner: string, entry: Subscription, document: BoardDocument) {
    if (entry.document !== document) {
      entry.scope = boardScriptScope(document, owner);
      entry.document = document;
      entry.selection = undefined;
    }
    return entry.scope;
  }
  return {
    get size() { return subscribers.size; },
    get transforms() { return [...subscribers.values()].some((entry) => entry.listens.has("transformend")); },
    update(owner: string, output: BoardScriptOutput | null) {
      const listens = new Set(EVENTS.filter((type) => output?.listens.includes(type)));
      if (!listens.size) { subscribers.delete(owner); return; }
      const entry = subscribers.get(owner) ?? { listens, scope: new Set<string>() };
      if (!listens.has("viewchange")) entry.view = undefined;
      if (!listens.has("selectionchange")) { entry.selection = undefined; entry.selected = undefined; }
      entry.listens = listens;
      subscribers.set(owner, entry);
    },
    sync(document: BoardDocument, selection: readonly string[], readView: () => BoardScriptView) {
      let view: BoardScriptView | undefined;
      let key: string | undefined;
      for (const [owner, entry] of subscribers) {
        if (entry.listens.has("viewchange")) {
          view ??= readView();
          key ??= JSON.stringify(view);
          if (entry.view !== key) {
            entry.view = key;
            send(owner, { type: "viewchange", data: view });
          }
        }
        if (entry.listens.has("selectionchange")) {
          const allowed = scope(owner, entry, document);
          if (entry.selection === selection) continue;
          entry.selection = selection;
          const ids = selection.filter((id) => allowed.has(id));
          if (entry.selected && ids.length === entry.selected.length && ids.every((id, i) => id === entry.selected?.[i])) continue;
          entry.selected = ids;
          send(owner, { type: "selectionchange", data: { ids } });
        }
      }
    },
    transform(document: BoardDocument, event: { ids: readonly string[]; operation: string; cancelled: boolean }) {
      for (const [owner, entry] of subscribers) {
        if (!entry.listens.has("transformend")) continue;
        const allowed = scope(owner, entry, document);
        const ids = event.ids.filter((id) => allowed.has(id));
        if (ids.length) send(owner, { type: "transformend", data: { ...event, ids } });
      }
    },
    clear() { subscribers.clear(); },
  };
}
