import { createActiveFsClient } from "$lib/features/space/modules/active-fs-client";
import {
	type ResolveWorkspaceAsset,
	resolveWorkspaceFileAsset,
} from "$lib/workspace-assets";

/**
 * Resolves workspace-relative markdown assets against a Space's live files.
 * Used by preview surfaces that have a Space but no file workspace controller.
 */
export function createSpaceWorkspaceAssetResolver(
	spaceId: string,
): ResolveWorkspaceAsset {
	const fs = createActiveFsClient({ spaceId, source: { kind: "live" } });
	return (path, { signal }) =>
		resolveWorkspaceFileAsset(fs.read, path, { signal });
}
