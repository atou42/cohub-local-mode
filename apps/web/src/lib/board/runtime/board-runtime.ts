import type {
	BoardCompositionInput,
	BoardEffectInput,
	BoardPlaybackSnapshot,
	BoardSemanticCommand,
} from "@cohub/protocol";
import {
	type BoardAnimationSpec,
	type BoardAuthoringSnapshot,
	parseBoardPlaybackPolicy,
} from "@cohub/protocol";
import type { AppNavigationOpenMessage } from "@cohub/protocol/app-navigation";
import { BoardAppearanceSchema } from "@cohub/protocol/board-document";
import type {
	AppRuntimeShellContext,
	BoardPlaybackPolicy,
} from "@neta-art/cohub";
import { BOARD_DOCUMENT_KIND, type BoardDocument } from "@neta-art/cohub/board";
import type {
	BoardAutomationActivity,
	BoardCollaboratorProfile,
} from "$lib/board/board-activity";
import type { BoardAssetSource } from "$lib/board/board-asset-source";
import { createLazyModuleLoader } from "$lib/lazy-module";

export type BoardRuntimeViewState = {
	path: string;
	visibleRect: {
		x: number;
		y: number;
		width: number;
		height: number;
	} | null;
	selectedNodes: Array<{ id: string; type: string; title?: string }>;
};

export type BoardRuntimeData = {
	boardId: string;
	effects: Array<BoardEffectInput & { revision: number }>;
	compositions: Array<BoardCompositionInput & { revision: number }>;
	/** Optional board-wide enter preset. Omitted means no automatic motion. */
	enter: BoardAnimationSpec | null;
	playback: BoardPlaybackSnapshot | null;
	playbackPolicy: BoardPlaybackPolicy | null;
};

export function boardRuntimeDataFromAuthoring(
	snapshot: BoardAuthoringSnapshot,
): BoardRuntimeData {
	const appearance = BoardAppearanceSchema.safeParse(
		snapshot.board.metadata.appearance,
	);
	return {
		boardId: snapshot.board.id,
		effects: snapshot.effects ?? [],
		compositions: snapshot.compositions ?? [],
		enter: appearance.success ? (appearance.data.motion?.enter ?? null) : null,
		playback: snapshot.playback ?? null,
		playbackPolicy: parseBoardPlaybackPolicy(snapshot.board.metadata),
	};
}

/**
 * Compare an entrance preset by value. Every appearance parse rebuilds it, so
 * reference equality would report a change on unrelated background edits.
 */
export function sameBoardAnimationSpec(
	a: BoardAnimationSpec | null,
	b: BoardAnimationSpec | null,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return (
		a.kind === b.kind &&
		a.kindVersion === b.kindVersion &&
		JSON.stringify(a.params) === JSON.stringify(b.params)
	);
}

export type BoardRuntimeDataDiff = {
	board: boolean;
	effects: boolean;
	compositions: boolean;
	enter: boolean;
	playback: boolean;
	playbackPolicy: boolean;
};

/** Reference diff for the runtime slices, with `enter` compared by value. */
export function diffBoardRuntimeData(
	prev: BoardRuntimeData,
	next: BoardRuntimeData,
): BoardRuntimeDataDiff {
	return {
		board: next.boardId !== prev.boardId,
		effects: next.effects !== prev.effects,
		compositions: next.compositions !== prev.compositions,
		enter: !sameBoardAnimationSpec(next.enter, prev.enter),
		playback: next.playback !== prev.playback,
		playbackPolicy: next.playbackPolicy !== prev.playbackPolicy,
	};
}

/**
 * How a Board runtime is being used.
 *
 * `view` is not "edit with the buttons hidden": it also drops realtime awareness,
 * workspace reads and every commit path, so the same runtime can render a
 * published Board for a viewer with no access to the origin Space.
 */
export type BoardRuntimeMode = "edit" | "view";

/** Persist a document change. Absent in view mode, which never commits. */
export type BoardCommitHandler = (
	document: BoardDocument,
	before: BoardDocument,
	commands: BoardSemanticCommand[],
) => void | Promise<void>;

/** Stable host contract for a complete board editor and renderer runtime. */
export type BoardRuntimeProps = {
	path: string;
	boardId: string;
	document: BoardDocument;
	runtime: BoardRuntimeData;
	spaceId: string;
	/** Runtime context forwarded to Apps rendered inside Board nodes. */
	shell?: AppRuntimeShellContext;
	onNavigationOpen?: (message: AppNavigationOpenMessage) => Promise<{
		handled: boolean;
		reason?: "unsupported" | "invalid_target" | "inaccessible" | "timeout";
		call?:
			| { ok: true; result?: unknown }
			| { ok: false; code: string; message: string };
	}>;
	mode?: BoardRuntimeMode;
	/**
	 * Where referenced media resolves from. Defaults to the live Space file API;
	 * a published Board passes an artifact-backed source instead.
	 */
	assetSource?: BoardAssetSource;
	/** Keep the editor mounted while suspending input and rendering. */
	active?: boolean;
	immersive?: boolean;
	syncError?: string | null;
	/**
	 * Compact viewport. Drives the local `client.formFactor` published to peers,
	 * so a touch contact from a phone can be presented as such rather than guessed
	 * from the pointer type alone.
	 */
	isMobile?: boolean;
	/** Display identities for collaborator cursors and automation markers. */
	collaborators?: Map<string, BoardCollaboratorProfile>;
	/** Recent CLI / Agent transactions, already resolved to a board focus. */
	activities?: BoardAutomationActivity[];
	/** Open the chat turn behind an Agent marker. */
	onOpenActivity?: (activity: BoardAutomationActivity) => void | Promise<void>;
	onCommit?: BoardCommitHandler;
	onRetrySync?: () => void | Promise<void>;
	onViewStateChange?: (state: BoardRuntimeViewState) => void;
	/**
	 * Open a workspace file in the preview panel. File cards on the board route
	 * here so activating one lands in the same place as clicking the file in the
	 * file tree, rather than opening a second, board-specific viewer.
	 */
	onOpenFile?: (path: string) => void | Promise<void>;
};

const loadCohubPixiRuntime = createLazyModuleLoader(
	() => import("$lib/components/board/BoardPanel.svelte"),
);

export const cohubPixiRuntime = {
	id: "cohub-pixi",
	modelKind: BOARD_DOCUMENT_KIND,
	load: loadCohubPixiRuntime,
} as const;

/** Resolve the runtime for a persisted semantic model, not for an engine name. */
export function resolveBoardRuntime(document: BoardDocument) {
	switch (document.kind) {
		case BOARD_DOCUMENT_KIND:
			return cohubPixiRuntime;
	}
}
