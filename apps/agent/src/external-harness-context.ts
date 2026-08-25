import type { ContentBlock } from "@cohub/protocol/core";
import { mergeSpaceMentionOrigins } from "./runtime/space-mention-origins.js";

export function appendCloudSpaceReadInstructions(
  prompt: string,
  contents: ContentBlock[][],
) {
  const cloudSpaceIds = Object.entries(mergeSpaceMentionOrigins(contents))
    .filter(([, origin]) => origin === "cloud")
    .map(([spaceId]) => spaceId);
  if (cloudSpaceIds.length === 0) return prompt;

  const commands = cloudSpaceIds
    .map(
      (spaceId) =>
        `For ${spaceId}, use \`"$COHUB_LOCAL_CLI" -s ${spaceId} spaces files ls\` and \`"$COHUB_LOCAL_CLI" -s ${spaceId} spaces files cat <path>\`.`,
    )
    .join("\n");
  return `${prompt}\n\n[Cohub context]\nThe explicitly mentioned Cloud Spaces are available read-only through the host-authorized Cohub CLI. Read them when the request requires their context; do not treat cohub:// links as local paths.\n${commands}`;
}

export function buildExternalHarnessEnvironment(input: {
	spaceId: string;
	sessionId: string;
	actorUserId: string;
	executionToken: string;
	apiBaseUrl: string;
	cliPath: string;
}) {
	const apiBaseUrl = input.apiBaseUrl.trim();
	if (!apiBaseUrl) {
		throw new Error("Local API base URL is required for external harnesses");
	}
	const cliPath = input.cliPath.trim();
	if (!cliPath.startsWith("/")) {
		throw new Error("Local Cohub CLI path is required for external harnesses");
	}
	return {
		COHUB_API_URL: apiBaseUrl,
		COHUB_LOCAL_CLI: cliPath,
		COHUB_SPACE_ID: input.spaceId,
    COHUB_SESSION_ID: input.sessionId,
    COHUB_USER_UUID: input.actorUserId,
    COHUB_EXECUTION_TOKEN: input.executionToken,
    COHUB_SOURCE_VIA: "tool",
  };
}
