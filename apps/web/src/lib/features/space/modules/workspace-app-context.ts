import type { AppRuntimeInvocationContext } from "@neta-art/cohub";

export type WorkspaceAppOpenContext = {
	source: "desktop_command" | "user" | "route";
	sessionId?: string;
	turnId?: string;
	toolCallId?: string;
};

export type WorkspaceAppInvocation = AppRuntimeInvocationContext & {
	surface: "app" | "overlay";
	source: WorkspaceAppOpenContext["source"];
	spaceId: string;
};

export function createWorkspaceAppInvocation(
	spaceId: string,
	input: WorkspaceAppOpenContext,
	surface: WorkspaceAppInvocation["surface"] = "app",
): WorkspaceAppInvocation {
	return {
		surface,
		source: input.source,
		spaceId,
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		...(input.turnId ? { turnId: input.turnId } : {}),
		...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
	};
}
