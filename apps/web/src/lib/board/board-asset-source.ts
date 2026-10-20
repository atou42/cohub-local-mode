import type { AppBoardAsset } from "@neta-art/cohub";
import type { BoardAssetSource } from "@neta-art/cohub/board";

export type { BoardAssetSource } from "@neta-art/cohub/board";

export function createSpaceBoardAssetSource(spaceId: string): BoardAssetSource {
	return {
		resolveFileUrl: async (path) => {
			const { resolveSpaceFileImageUrl } = await import(
				"$lib/board/board-image-urls"
			);
			return resolveSpaceFileImageUrl(spaceId, path);
		},
		resolvePlaybackUrl: async (path) => {
			const { resolveSpaceFilePlaybackUrl } = await import(
				"$lib/board/board-image-urls"
			);
			return resolveSpaceFilePlaybackUrl(spaceId, path);
		},
	};
}

export function createAppBoardAssetSource(input: {
	manifestUrl: string;
	assets: AppBoardAsset[];
}): BoardAssetSource {
	const base = new URL(".", input.manifestUrl);
	const byPath = new Map(
		input.assets
			.filter((asset) => asset.status === "captured" && asset.artifactPath)
			.map((asset) => [asset.sourcePath, asset.artifactPath as string]),
	);
	const resolveArtifactUrl = async (path: string) => {
		const artifactPath = byPath.get(path);
		return artifactPath ? new URL(artifactPath, base).toString() : null;
	};
	return {
		resolveFileUrl: resolveArtifactUrl,
		resolvePlaybackUrl: resolveArtifactUrl,
	};
}
