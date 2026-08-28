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

export function appendLocalGenerationInstructions(prompt: string): string {
	return `${prompt}\n\n[Cohub generation]\nWhen the user asks for an image, video, audio, or another multimodal asset, use the host Cohub CLI instead of calling a provider directly. First inspect available models with \`"$COHUB_LOCAL_CLI" models ls --model-type multimodal\`, then run \`"$COHUB_LOCAL_CLI" generate <prompt> -m <model>\` with the required parameters and inputs. The command submits through the local node and returns the generated asset; expose any failure and preserve the returned URL or saved file path.`;
}

export function appendCursorLocalContextInstructions(prompt: string): string {
	const agentsPath = process.env.LOCAL_USER_AGENTS_PATH?.trim() || "~/.codex/AGENTS.md";
	const skillsPath = process.env.LOCAL_AGENT_SKILLS_PATH?.trim() || "~/.agents/skills";
	return `${prompt}\n\n[Local Cursor context]\nBefore acting, read ${agentsPath} when it exists and follow its workspace rules. Discover relevant skills under ${skillsPath} and read their SKILL.md files before using them. Keep the current Space workspace as the source of truth; do not copy credentials or private files into the cloud.`;
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
		...(process.env.LOCAL_USER_AGENTS_PATH?.trim()
			? { LOCAL_USER_AGENTS_PATH: process.env.LOCAL_USER_AGENTS_PATH.trim() }
			: {}),
		...(process.env.LOCAL_AGENT_SKILLS_PATH?.trim()
			? { LOCAL_AGENT_SKILLS_PATH: process.env.LOCAL_AGENT_SKILLS_PATH.trim() }
			: {}),
	};
}
