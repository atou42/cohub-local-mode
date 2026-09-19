import type { ContentBlock } from "@cohub/protocol/core";
import { mergeSpaceMentionOrigins } from "./runtime/space-mention-origins.js";
import {
	LOCAL_SESSION_MANIFEST_ENV,
	LOCAL_SESSION_REGISTRY_ENV,
	LOCAL_SESSION_TRANSCRIPT_ENV,
	localSessionRegistryPaths,
} from "./local-session-registry-core.js";
import { getAgentWorkspacePath } from "./runtime/paths.js";

export function appendCloudSpaceInstructions(
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
        `For ${spaceId}, use \`"$COHUB_LOCAL_CLI" -s ${spaceId} spaces files ls\`, \`cat <path>\`, \`write <path> -c <content>\`, \`mkdir <path>\`, \`mv <from> <to>\`, or \`rm <path>\` as required.`,
    )
    .join("\n");
  return `${prompt}\n\n[Cohub context]\nExplicitly mentioned Cloud Spaces are available through the host-authorized Cohub CLI with the connected account's real permissions. Use the CLI to read or mutate them when the request requires it; do not treat cohub:// links as local paths. Permission, identity, and transport failures must be reported exactly instead of being described as read-only access.\n${commands}`;
}

export function appendLocalGenerationInstructions(prompt: string): string {
	return `${prompt}\n\n[Cohub generation]\nWhen the user asks for an image, video, audio, or another multimodal asset, use the host Cohub CLI instead of calling a provider directly. First inspect available models with \`"$COHUB_LOCAL_CLI" models ls --model-type multimodal\`, then run \`"$COHUB_LOCAL_CLI" generate <prompt> -m <model>\` with the required parameters and inputs. The command submits through the local node and returns the generated asset; expose any failure and preserve the returned URL or saved file path.`;
}

export function appendLocalSessionRegistryInstructions(prompt: string): string {
	return `${prompt}\n\n[Local Space sessions]\nShared local session records for this Space are available under \`$${LOCAL_SESSION_REGISTRY_ENV}\`. Use \`index.json\` to discover Cohub Sessions and read their normalized \`transcript.jsonl\` files when another local session is relevant. The manifest maps Cohub and native harness session IDs. Treat native harness artifacts as read-only and report a missing or malformed mapping instead of guessing a path.`;
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
	const registryPaths = localSessionRegistryPaths({
		workspacePath: getAgentWorkspacePath(input.spaceId),
		sessionId: input.sessionId,
	});
	return {
		COHUB_API_URL: apiBaseUrl,
		COHUB_LOCAL_CLI: cliPath,
		COHUB_SPACE_ID: input.spaceId,
    COHUB_SESSION_ID: input.sessionId,
    COHUB_USER_UUID: input.actorUserId,
    COHUB_EXECUTION_TOKEN: input.executionToken,
		COHUB_SOURCE_VIA: "tool",
		[LOCAL_SESSION_REGISTRY_ENV]: registryPaths.root,
		[LOCAL_SESSION_MANIFEST_ENV]: registryPaths.manifest,
		[LOCAL_SESSION_TRANSCRIPT_ENV]: registryPaths.transcript,
		...(process.env.LOCAL_USER_AGENTS_PATH?.trim()
			? { LOCAL_USER_AGENTS_PATH: process.env.LOCAL_USER_AGENTS_PATH.trim() }
			: {}),
		...(process.env.LOCAL_AGENT_SKILLS_PATH?.trim()
			? { LOCAL_AGENT_SKILLS_PATH: process.env.LOCAL_AGENT_SKILLS_PATH.trim() }
			: {}),
	};
}
