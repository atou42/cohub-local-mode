import type { SessionRecord } from "../types.js";
import { HttpError } from "../transport.js";

export function requireSessionContext<T extends { session: SessionRecord }>(
  response: T,
  spaceId: string,
  sessionId: string,
): T {
  if (
    response.session.spaceId !== spaceId ||
    response.session.id !== sessionId
  ) {
    throw new HttpError("Session not found in this space", 404, {
      code: "session_context_mismatch",
    });
  }
  return response;
}
