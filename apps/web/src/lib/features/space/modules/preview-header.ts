import type { ComponentType } from "svelte";

/**
 * Any renderable icon component. Lucide ships legacy class components, so this
 * accepts both them and runes components.
 */
export type PreviewIcon = ComponentType;

/**
 * A preview header action.
 *
 * `primary` actions render inline on the right of the tab strip (pinned, never
 * covered by the scrolling tabs). Everything else collapses into the single
 * "⋯" menu so the header stays calm as features grow.
 */
export type PreviewHeaderAction = {
	id: string;
	label: string;
	icon: PreviewIcon;
	/**
	 * Runs the action. `anchor` is a stable element to hang a follow-up popover on
	 * (the menu trigger for overflow actions), so it survives the menu closing.
	 */
	run: (event: MouseEvent, anchor: HTMLElement | null) => void | Promise<void>;
	/** Rendered inline instead of the ⋯ menu. Keep this list short. */
	primary?: boolean;
	active?: boolean;
	disabled?: boolean;
	danger?: boolean;
	/** Keeps ordering stable while conditionally hiding the action. */
	hidden?: boolean;
};

/**
 * Presentation of the preview header. The tabs, actions and ⋯ menu are shared;
 * only the shell differs.
 */
export type PreviewHeaderVariant = "dock" | "mobile" | "float";

/** A choice rendered by an adaptive segmented/popover control. */
export type PreviewOption = {
	value: string;
	label: string;
	icon: PreviewIcon;
	title?: string;
};

export type PreviewChrome = {
	focus: boolean;
	immersive: boolean;
	treeVisible: boolean;
	onToggleFocus?: () => void | Promise<void>;
	onToggleImmersive?: () => void | Promise<void>;
	onToggleTree?: () => void | Promise<void>;
};

export function previewHeaderVariant(input: {
	isMobile: boolean;
	immersive: boolean;
}): PreviewHeaderVariant {
	if (input.isMobile) return "mobile";
	return input.immersive ? "float" : "dock";
}
