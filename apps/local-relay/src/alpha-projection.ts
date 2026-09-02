import { isAlphaLocalApiRequest, type RelayCommand } from "./protocol.ts";

export const ALPHA_PROJECTION_MAX_BODY_BYTES = 96 * 1024;
export const ALPHA_PROJECTION_STORAGE_PREFIX = "alpha-projection:";

export type AlphaReadProjection = {
	path: string;
	result: NonNullable<RelayCommand["result"]>;
	updatedAt: string;
};

export function alphaProjectionStorageKey(path: string) {
	return `${ALPHA_PROJECTION_STORAGE_PREFIX}${path}`;
}

export function createAlphaReadProjection(
	command: RelayCommand,
	updatedAt = new Date().toISOString(),
): AlphaReadProjection | null {
	if (
		command.status !== "succeeded" ||
		command.request.method !== "GET" ||
		!command.result ||
		!isAlphaLocalApiRequest(command.request.method, command.request.path) ||
		command.result.status < 200 ||
		command.result.status >= 300 ||
		new TextEncoder().encode(command.result.body).byteLength >
			ALPHA_PROJECTION_MAX_BODY_BYTES
	) {
		return null;
	}
	return {
		path: command.request.path,
		result: command.result,
		updatedAt,
	};
}
