import type { ContentBlock } from "@cohub/protocol/core";
import { requestSourceToHeaders } from "@cohub/protocol/provenance";
import type { ExecutionAuthPrincipal } from "../auth.js";

type RecentSessionTurn = {
  status: string;
  userUuid: string | null;
  userContent: ContentBlock[];
};

type CloudSpaceProxyDependencies = {
  nodeOrigin: "cloud" | "local";
  cloudApiOrigin: string;
  loadRecentSessionTurns: (sessionId: string) => Promise<RecentSessionTurn[]>;
  resolveAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string | null>;
  fetch: typeof fetch;
  now?: () => number;
};

type CloudSpaceProxyInput = {
  execution: ExecutionAuthPrincipal;
  targetSpaceId: string;
  endpoint: "tree" | "file" | "dir" | "node" | "move";
  path: string;
  method?: "GET" | "PUT" | "POST" | "DELETE";
  body?: string;
  contentType?: string | null;
  query?: string;
};

const ACTIVE_TURN_STATUSES = new Set(["running", "abort_requested"]);
const ACCOUNT_VERIFICATION_TTL_MS = 60_000;

function jsonError(status: number, code: string, message: string) {
  return Response.json({ code, message }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function collectCloudSpaceIds(turns: RecentSessionTurn[], actorUserId: string) {
  const origins = new Map<string, "cloud" | "local">();
  for (const turn of turns) {
    if (!ACTIVE_TURN_STATUSES.has(turn.status) || turn.userUuid !== actorUserId) continue;
    for (const block of turn.userContent) {
      const mentions = block._meta?.mentions;
      if (mentions === undefined) continue;
      if (!Array.isArray(mentions)) {
        throw new Error("Space mention metadata is invalid: mentions must be an array.");
      }
      for (const rawMention of mentions) {
        const mention = record(rawMention);
        if (mention?.type !== "space" || typeof mention.spaceId !== "string") continue;
        if (mention.origin === undefined) continue;
        if (mention.origin !== "cloud" && mention.origin !== "local") {
          throw new Error(`Space mention ${mention.spaceId} has an invalid origin.`);
        }
        const previous = origins.get(mention.spaceId);
        if (previous && previous !== mention.origin) {
          throw new Error(`Space mention ${mention.spaceId} has conflicting origins.`);
        }
        origins.set(mention.spaceId, mention.origin);
      }
    }
  }
  return new Set(
    [...origins.entries()]
      .filter(([, origin]) => origin === "cloud")
      .map(([spaceId]) => spaceId),
  );
}

function relayCloudResponse(response: Response) {
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const name of ["content-type", "retry-after", "etag", "last-modified"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function createCloudSpaceProxy(deps: CloudSpaceProxyDependencies) {
  const now = deps.now ?? Date.now;
  let verifiedAccount: {
    token: string;
    actorUserId: string;
    expiresAt: number;
  } | null = null;

  const verifyAccount = async (
    actorUserId: string,
    forceRefresh = false,
  ): Promise<{ token: string } | { response: Response }> => {
    let token: string | null;
    try {
      token = await deps.resolveAccessToken({ forceRefresh });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        response: jsonError(
          502,
          "cloud_auth_unavailable",
          `Cloud account authentication failed: ${message}`,
        ),
      };
    }
    if (!token) {
      return {
        response: jsonError(
          401,
          "cloud_account_not_connected",
          "Cloud account is not connected. Run cohub auth login on the host.",
        ),
      };
    }
    if (
      !forceRefresh &&
      verifiedAccount?.token === token &&
      verifiedAccount.actorUserId === actorUserId &&
      verifiedAccount.expiresAt > now()
    ) {
      return { token };
    }

    let meResponse: Response;
    try {
      meResponse = await deps.fetch(new URL("/api/me", deps.cloudApiOrigin), {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        response: jsonError(
          502,
          "cloud_unreachable",
          `Cloud Space is unreachable: ${message}`,
        ),
      };
    }
    if (meResponse.status === 401 && !forceRefresh) {
      return verifyAccount(actorUserId, true);
    }
    if (!meResponse.ok) {
      return {
        response: jsonError(
          meResponse.status === 401 ? 401 : 502,
          "cloud_account_verification_failed",
          `Cloud account verification returned HTTP ${meResponse.status}.`,
        ),
      };
    }

    const me = await meResponse.json().catch(() => null) as { uuid?: unknown } | null;
    if (typeof me?.uuid !== "string") {
      return {
        response: jsonError(
          502,
          "cloud_account_response_invalid",
          "Cloud account verification returned an invalid response.",
        ),
      };
    }
    if (me.uuid !== actorUserId) {
      return {
        response: jsonError(
          403,
          "cloud_account_mismatch",
          "The connected cloud account does not match this Cohub user.",
        ),
      };
    }
    verifiedAccount = {
      token,
      actorUserId,
      expiresAt: now() + ACCOUNT_VERIFICATION_TTL_MS,
    };
    return { token };
  };

  return async function proxyCloudSpace(
    input: CloudSpaceProxyInput,
  ): Promise<Response | null> {
    if (deps.nodeOrigin !== "local" || input.targetSpaceId === input.execution.spaceId) {
      return null;
    }
    const actorUserId = input.execution.actorUserId;
    const sessionId = input.execution.sessionId;
    if (!actorUserId || !sessionId) {
      return jsonError(
        403,
        "cloud_proxy_context_invalid",
        "Cloud Space access requires an actor-bound Session execution.",
      );
    }

    let cloudSpaceIds: Set<string>;
    try {
      const turns = await deps.loadRecentSessionTurns(sessionId);
      cloudSpaceIds = collectCloudSpaceIds(turns, actorUserId);
    } catch (error) {
      return jsonError(
        409,
        "cloud_mention_metadata_invalid",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!cloudSpaceIds.has(input.targetSpaceId)) return null;

    let verified = await verifyAccount(actorUserId);
    if ("response" in verified) return verified.response;

    const requestCloud = (token: string) => {
      const url = new URL(
        `/api/spaces/${encodeURIComponent(input.targetSpaceId)}/fs/${input.endpoint}`,
        deps.cloudApiOrigin,
      );
      if (input.query) {
        const query = new URLSearchParams(input.query.startsWith("?") ? input.query.slice(1) : input.query);
        for (const [name, value] of query) url.searchParams.append(name, value);
      } else if (input.path) {
        url.searchParams.set("path", input.path);
      }
      const method = input.method ?? "GET";
      return deps.fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(input.contentType ? { "Content-Type": input.contentType } : {}),
          ...requestSourceToHeaders({
            spaceId: input.execution.spaceId,
            sessionId,
            turnId: input.execution.turnId ?? undefined,
            via: "tool",
          }),
        },
        ...(method === "GET" || method === "DELETE" || input.body === undefined
          ? {}
          : { body: input.body }),
      });
    };

    let cloudResponse: Response;
    try {
      cloudResponse = await requestCloud(verified.token);
      if (cloudResponse.status === 401) {
        verifiedAccount = null;
        verified = await verifyAccount(actorUserId, true);
        if ("response" in verified) return verified.response;
        cloudResponse = await requestCloud(verified.token);
      }
    } catch (error) {
      return jsonError(
        502,
        "cloud_unreachable",
        `Cloud Space is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (cloudResponse.status === 401) {
      return jsonError(
        401,
        "cloud_account_not_connected",
        "Cloud account is not connected or its session expired.",
      );
    }
    return relayCloudResponse(cloudResponse);
  };
}
