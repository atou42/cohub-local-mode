import { collectBoardAssetReferences, type BoardSnapshot } from "@cohub/protocol";
import { loadBoardScriptSources } from "@cohub/protocol/board-script-modules";

export async function collectBoardPublishReferences(
  board: Pick<BoardSnapshot, "items" | "board">,
  readModule: (path: string) => Promise<string>,
  maxFiles: number,
) {
  const references = collectBoardAssetReferences(board);
  const files = new Set(references.files);
  const modules = new Map<string, Promise<string>>();
  const checkLimit = () => {
    if (files.size > maxFiles) throw new RangeError(`Board references more than ${maxFiles} assets.`);
  };
  checkLimit();
  const read = (path: string) => {
    let pending = modules.get(path);
    if (!pending) {
      files.add(path);
      checkLimit();
      pending = readModule(path);
      modules.set(path, pending);
    }
    return pending;
  };
  for (const entry of references.scripts) await loadBoardScriptSources(entry, read);
  return { files: [...files].sort(), urls: references.urls };
}
