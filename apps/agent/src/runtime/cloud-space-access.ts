import { HttpError } from "@neta-art/cohub";
import type { AgentFileVisibility } from "./workspace-visibility.js";

function cloudError(error: unknown, action: string): never {
  if (error instanceof HttpError) {
    if (error.status === 401) throw new Error("Cloud account is not connected or its session expired.");
    if (error.status === 403) throw new Error("Cloud Space file access denied.");
    if (error.status === 404) throw new Error("Cloud Space not found.");
  }
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`Cloud Space ${action} failed: ${message}`);
}

export function createCloudSpaceFileVisibilityResolver(dependencies: {
  getMe: () => Promise<{ uuid: string }>;
  getSpace: (spaceId: string) => Promise<{ access?: { permissions?: string[] | null } | null }>;
}) {
  let identityCache: { actorUserId: string; expiresAt: number } | null = null;
  return async function resolve(input: {
    actorUserId: string;
    spaceId: string;
  }): Promise<AgentFileVisibility> {
    if (!(identityCache?.actorUserId === input.actorUserId && identityCache.expiresAt > Date.now())) {
      try {
        const me = await dependencies.getMe();
        if (me.uuid !== input.actorUserId) {
          throw new Error("Connected cloud account does not match the local session user.");
        }
        identityCache = { actorUserId: input.actorUserId, expiresAt: Date.now() + 30_000 };
      } catch (error) {
        cloudError(error, "account verification");
      }
    }

    try {
      const space = await dependencies.getSpace(input.spaceId);
      const permissions = new Set(space.access?.permissions ?? []);
      if (permissions.has("file.view")) return "full";
      if (permissions.has("file.view.filtered")) return "filtered";
      throw new Error("Cloud Space file access denied.");
    } catch (error) {
      if (error instanceof Error && error.message === "Cloud Space file access denied.") throw error;
      cloudError(error, "access check");
    }
  };
}
