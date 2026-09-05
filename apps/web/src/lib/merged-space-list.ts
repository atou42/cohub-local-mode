import type { SpaceRecord } from "@neta-art/cohub";
import { registerSpaceOrigins, type SpaceOrigin } from "./space-origin";

export class PartialSpaceListError extends Error {
	readonly spaces: SpaceRecord[];
	readonly failures: Array<{ origin: SpaceOrigin; error: unknown }>;

	constructor(spaces: SpaceRecord[], failures: Array<{ origin: SpaceOrigin; error: unknown }>) {
		super(`${failures.map(({ origin }) => origin === "local" ? "Local" : "Cloud").join(" and ")} spaces could not be loaded. Available spaces are shown.`, {
			cause: new AggregateError(failures.map(({ error }) => error)),
		});
		this.name = "PartialSpaceListError";
		this.spaces = spaces;
		this.failures = failures;
	}
}

export async function listMergedSpaces(
	local: () => Promise<SpaceRecord[]>,
	cloud: () => Promise<SpaceRecord[]>,
): Promise<SpaceRecord[]> {
	const results = await Promise.allSettled([Promise.resolve().then(local), Promise.resolve().then(cloud)]);
	const spaces: SpaceRecord[] = [];
	const failures: Array<{ origin: SpaceOrigin; error: unknown }> = [];
	for (const [index, result] of results.entries()) {
		const origin = index === 0 ? "local" : "cloud";
		if (result.status === "rejected") {
			failures.push({ origin, error: result.reason });
		} else {
			if (!Array.isArray(result.value) || result.value.some((space) => !space || typeof space.id !== "string" || !space.id.trim())) {
				throw new TypeError(`${origin} space list is invalid`);
			}
			spaces.push(...result.value.map<SpaceRecord>((space) => ({ ...space, origin })));
		}
	}
	registerSpaceOrigins(spaces);
	if (failures.length === 2) throw new AggregateError(failures.map(({ error }) => error), "Local and cloud spaces could not be loaded.");
	if (failures.length) throw new PartialSpaceListError(spaces, failures);
	return spaces;
}
