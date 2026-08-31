import type { SpaceOrigin } from "$lib/space-origin";

export function routeSpacePinClient<T>(
	spaceId: string,
	resolveOrigin: (spaceId: string) => SpaceOrigin,
	clientForOrigin: (origin: SpaceOrigin) => T,
): T {
	return clientForOrigin(resolveOrigin(spaceId));
}
