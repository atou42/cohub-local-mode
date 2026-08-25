import { HttpError } from "@neta-art/cohub";
import { localNodeErrorMessage } from "$lib/local-node-error";

/**
 * Unified access state derived from space/session loads and API errors.
 * Every "limited or no permission" scenario maps to one of these states,
 * so the UI can render a single, consistent surface instead of ad-hoc
 * red error boxes.
 */
export type AccessState =
	| { kind: "loading" }
	| { kind: "full" }
	| { kind: "minimal" }
	| { kind: "not-found"; resource?: string }
	| { kind: "forbidden"; isAuthenticated: boolean; resource?: string }
	| { kind: "unauthorized"; resource?: string }
	| { kind: "error"; message: string; resource?: string };

export type ClassifyOptions = {
	isAuthenticated?: boolean;
	isLocalSpace?: boolean;
	resource?: string;
};

/**
 * Map an arbitrary error (typically from an SDK call) to an AccessState.
 * HttpError status codes are the primary signal:
 *   401 → unauthorized   403 → forbidden   404 → not-found
 * Everything else is a generic error with the message surfaced.
 */
export function classifyAccessError(
	error: unknown,
	options: ClassifyOptions = {},
): AccessState {
	const { isAuthenticated = false, isLocalSpace = false, resource } = options;
	if (error instanceof HttpError) {
		if (error.status === 401) return { kind: "unauthorized", resource };
		if (error.status === 403)
			return { kind: "forbidden", isAuthenticated, resource };
		if (error.status === 404) return { kind: "not-found", resource };
	}
	const message = localNodeErrorMessage(
		error,
		"Something went wrong",
		isLocalSpace,
	);
	return { kind: "error", message, resource };
}

/** Whether this state should completely replace the workspace view. */
export function isBlockingAccessState(state: AccessState): boolean {
	return (
		state.kind === "not-found" ||
		state.kind === "forbidden" ||
		state.kind === "unauthorized" ||
		state.kind === "error"
	);
}
