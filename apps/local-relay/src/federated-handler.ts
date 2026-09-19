import { authorizeFederatedFileRequest } from "./federated-api.ts";
import {
	RelayProtocolError,
	type RelayCommand,
	type RelayCommandAccepted,
} from "./protocol.ts";

const FEDERATED_COMMAND_WAIT_MS = 30_000;
const FEDERATED_COMMAND_POLL_MS = 100;

type RelayStub = {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

type FederatedHandlerRuntime = {
	fetch?: typeof fetch;
	now?: () => number;
	wait?: (milliseconds: number) => Promise<void>;
};

function json(value: unknown, status = 200) {
	return Response.json(value, {
		status,
		headers: { "cache-control": "no-store" },
	});
}

const defaultWait = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function handleFederatedApi(
	input: {
		request: Request;
		stub: RelayStub;
		cloudApiOrigin: string;
		ownerUserId: string;
		maxBodyBytes: number;
	},
	runtime: FederatedHandlerRuntime = {},
) {
	const fetcher = runtime.fetch ?? fetch;
	const now = runtime.now ?? Date.now;
	const wait = runtime.wait ?? defaultWait;
	const authorized = await authorizeFederatedFileRequest(input.request, {
		cloudApiOrigin: input.cloudApiOrigin,
		ownerUserId: input.ownerUserId,
		fetch: fetcher,
		maxBodyBytes: input.maxBodyBytes,
	});
	const statusResponse = await input.stub.fetch(
		"https://relay.internal/internal/status",
	);
	const status = await statusResponse
		.json<{ connected?: unknown }>()
		.catch(() => null);
	if (!statusResponse.ok || status?.connected !== true) {
		return json(
			{ code: "local_node_offline", message: "The Local node is offline" },
			503,
		);
	}

	const acceptedResponse = await input.stub.fetch(
		"https://relay.internal/internal/commands",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				kind: "federated_fs",
				idempotencyKey: authorized.idempotencyKey,
				request: authorized.request,
				attachmentIds: [],
			}),
		},
	);
	if (!acceptedResponse.ok) return acceptedResponse;
	const accepted = await acceptedResponse.json<RelayCommandAccepted>();
	const commandId = accepted.command?.id;
	if (!commandId) {
		throw new RelayProtocolError(
			"relay_command_response_invalid",
			"The Local relay returned no command identity",
			502,
		);
	}

	const deadline = now() + FEDERATED_COMMAND_WAIT_MS;
	for (;;) {
		const response = await input.stub.fetch(
			`https://relay.internal/internal/commands/${encodeURIComponent(commandId)}`,
		);
		if (!response.ok) return response;
		const payload = await response.json<{ command?: RelayCommand }>();
		const command = payload.command;
		if (!command) {
			throw new RelayProtocolError(
				"relay_command_response_invalid",
				"The Local relay returned an invalid command",
				502,
			);
		}
		if (command.status === "succeeded" && command.result) {
			const headers = new Headers(command.result.headers);
			headers.set("cache-control", "no-store");
			return new Response(command.result.body, {
				status: command.result.status,
				headers,
			});
		}
		if (
			command.status === "failed" ||
			command.status === "cancelled"
		) {
			return json(
				{
					code: command.errorCode ?? `relay_command_${command.status}`,
					message:
						command.errorMessage ??
						`The Local relay command ${command.status}`,
				},
				command.status === "cancelled" ? 409 : 502,
			);
		}
		if (now() >= deadline) {
			return json(
				{
					code: "local_node_timeout",
					message:
						"The Local node did not finish the filesystem request before the relay timeout",
				},
				504,
			);
		}
		await wait(FEDERATED_COMMAND_POLL_MS);
	}
}
