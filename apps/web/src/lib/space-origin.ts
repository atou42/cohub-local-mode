import type { SpaceRecord } from "@neta-art/cohub";

export type SpaceOrigin = "cloud" | "local";

const originBySpaceId = new Map<string, SpaceOrigin>();
const LOCAL_SPACE_IDS_KEY = "cohub:local-space-ids:v1";
let registryHydrated = false;

function hydrateOriginRegistry() {
	if (
		registryHydrated ||
		typeof localStorage === "undefined" ||
		typeof localStorage.getItem !== "function"
	)
		return;
	registryHydrated = true;
	const raw = localStorage.getItem(LOCAL_SPACE_IDS_KEY);
	if (!raw) return;
	const parsed = JSON.parse(raw) as unknown;
	if (
		!Array.isArray(parsed) ||
		parsed.some((id) => typeof id !== "string" || !id)
	) {
		throw new Error("Local Space origin registry is corrupt");
	}
	for (const id of parsed) originBySpaceId.set(id, "local");
}

function persistLocalSpaceIds() {
	if (
		typeof localStorage === "undefined" ||
		typeof localStorage.setItem !== "function"
	)
		return;
	const ids = Array.from(originBySpaceId.entries())
		.filter(([, origin]) => origin === "local")
		.map(([id]) => id)
		.sort();
	localStorage.setItem(LOCAL_SPACE_IDS_KEY, JSON.stringify(ids));
}

export function getSpaceOrigin(
	space: Pick<SpaceRecord, "origin">,
): SpaceOrigin {
	if (space.origin === undefined || space.origin === "cloud") return "cloud";
	if (space.origin === "local") return "local";
	throw new Error(`Unsupported Space origin: ${String(space.origin)}`);
}

export function isLocalSpace(
	space: Pick<SpaceRecord, "origin"> | null | undefined,
) {
	return Boolean(space && getSpaceOrigin(space) === "local");
}

export function registerSpaceOrigin(
	space: Pick<SpaceRecord, "id" | "origin">,
): SpaceOrigin {
	hydrateOriginRegistry();
	const origin = getSpaceOrigin(space);
	const existing = originBySpaceId.get(space.id);
	if (existing && existing !== origin) {
		throw new Error(
			`Space ${space.id} was returned by both local and cloud nodes`,
		);
	}
	originBySpaceId.set(space.id, origin);
	persistLocalSpaceIds();
	return origin;
}

export function registerSpaceOrigins(
	spaces: Array<Pick<SpaceRecord, "id" | "origin">>,
) {
	for (const space of spaces) registerSpaceOrigin(space);
}

export function getRegisteredSpaceOrigin(spaceId: string): SpaceOrigin | null {
	hydrateOriginRegistry();
	return originBySpaceId.get(spaceId) ?? null;
}

export function resolveSpaceOrigin(spaceId: string): SpaceOrigin {
	hydrateOriginRegistry();
	const registered = originBySpaceId.get(spaceId);
	if (registered) return registered;
	if (typeof window === "undefined") return "cloud";
	if (!window.location.pathname.includes(`/spaces/${spaceId}`)) return "cloud";
	const requested = new URLSearchParams(window.location.search).get("origin");
	if (requested === null || requested === "cloud") return "cloud";
	if (requested === "local") return "local";
	throw new Error(`Unsupported Space origin: ${requested}`);
}

export function routeWithSpaceOrigin(route: string, origin: SpaceOrigin) {
	if (origin === "cloud") return route;
	const [pathAndQuery, hash = ""] = route.split("#", 2);
	const [pathname, query = ""] = (pathAndQuery ?? route).split("?", 2);
	const params = new URLSearchParams(query);
	params.set("origin", "local");
	return `${pathname}?${params.toString()}${hash ? `#${hash}` : ""}`;
}
