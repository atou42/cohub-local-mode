type SpaceMention = { origin?: unknown; spaceId?: unknown };

function localTargetIds(mentions: SpaceMention[]) {
	return [
		...new Set(
			mentions.flatMap((mention) =>
				mention.origin === "local" && typeof mention.spaceId === "string"
					? [mention.spaceId]
					: [],
			),
		),
	];
}

export function buildLocalFederatedPromptEnv(input: {
	useLocalRelay: boolean;
	relayEnabled: boolean;
	mentions: SpaceMention[];
	apiUrl: string;
}): Record<string, string> | null {
	if (
		input.useLocalRelay ||
		!input.relayEnabled ||
		!input.mentions.some((mention) => mention.origin === "local")
	) {
		return null;
	}
	let url: URL;
	try {
		url = new URL(input.apiUrl.trim());
	} catch (error) {
		throw new Error("Local federated API URL is invalid", { cause: error });
	}
	if (
		url.protocol !== "https:" ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new Error("Local federated API URL must be an HTTPS origin");
	}
	return { COHUB_API_URL: url.origin };
}

export function buildLocalFederatedPromptContext(mentions: SpaceMention[]): {
	type: "text";
	text: string;
	_meta: {
		attachmentKind: "viewport";
		viewports: [];
		runtimeContext: "local_federated_fs_v1";
	};
} | null {
	const targets = localTargetIds(mentions);
	if (targets.length === 0) return null;
	return {
		type: "text",
		text: [
			"Local Space bridge runtime context:",
			`The explicitly mentioned Local Space IDs are: ${targets.join(", ")}.`,
			"For filesystem access to those Local Spaces, do not use the installed `cohub` CLI: this Cloud image does not route that CLI through the Local bridge.",
			"Use `curl --fail-with-body --silent --show-error` against `$COHUB_API_URL` instead. Never print any authentication or source environment variable.",
			"Every request must include these headers: `authorization: Bearer $COHUB_EXECUTION_TOKEN`, `x-cohub-source-space: $COHUB_SPACE_ID`, `x-cohub-source-session: $COHUB_SESSION_ID`, `x-cohub-source-turn: $COHUB_TURN_ID`, and `x-cohub-source-tool-call: $COHUB_TOOL_CALL_ID`.",
			'Allowed filesystem routes under `/api/spaces/<local-space-id>/fs/` are: GET `tree?path=<url-encoded-path>` to list; GET `file?path=<url-encoded-path>` to read; PUT `file` with JSON `{path,content,encoding:"utf-8"}` to write; POST `dir` with JSON `{path}` to create a directory; POST `move` with JSON `{fromPath,toPath}` to move; DELETE `node?path=<url-encoded-path>&recursive=<true-or-false>` to delete.',
			"Build JSON bodies with `jq -nc --arg` and URL-encode query values. Do not call any other route. Treat every non-2xx response as a failure and preserve its response body for the user.",
		].join("\n"),
		_meta: {
			attachmentKind: "viewport",
			viewports: [],
			runtimeContext: "local_federated_fs_v1",
		},
	};
}
