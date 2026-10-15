import { parseBoardMediaSource } from "./board-model.js";
import type { BoardSnapshot } from "./board.js";

export function collectBoardAssetReferences(
	board: Pick<BoardSnapshot, "items" | "board">,
): { files: string[]; urls: string[]; scripts: string[] } {
	const scripts = new Set<string>();
	const files = new Set<string>();
	const urls = new Set<string>();
	const add = (value: unknown) => {
		if (typeof value !== "string") return;
		const source = parseBoardMediaSource(value);
		if (source?.kind === "file") files.add(source.value);
		else if (source?.kind === "url") urls.add(source.value);
	};
	for (const item of Object.values(board.items)) {
		const props = item.props as {
			src?: unknown;
			snapshot?: {
				coverPath?: unknown;
				coverUrl?: unknown;
				artifacts?: Array<{ url?: unknown; previewUrl?: unknown }>;
			};
		} | undefined;
		const src = (item.script as { src?: unknown } | undefined)?.src;
		if (typeof src === "string") { scripts.add(src); add(src); }
		add(props?.src);
		if (item.type === "file") {
			add(props?.snapshot?.coverPath);
			add(props?.snapshot?.coverUrl);
		}
		if (item.type === "task" && Array.isArray(props?.snapshot?.artifacts)) {
			for (const artifact of props.snapshot.artifacts) {
				add(artifact.url);
				add(artifact.previewUrl);
			}
		}
	}
	const background = board.board.background as { imageUrl?: unknown } | undefined;
	add(background?.imageUrl);
	return { files: [...files].sort(), urls: [...urls].sort(), scripts: [...scripts].sort() };
}
