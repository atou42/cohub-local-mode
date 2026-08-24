import {
	type CohubClient,
	type CohubClientOptions,
	createCohubClient,
	type SpaceRecord,
} from "@neta-art/cohub";
import { env } from "$env/dynamic/public";
import { PUBLIC_API_ORIGIN, PUBLIC_GATEWAY_ORIGIN } from "$env/static/public";
import {
	clearAuthToken,
	getAuthSessionSnapshot,
	getAuthToken as resolveAccessToken,
	setAuthToken,
} from "$lib/auth";
import { getCurrentRedirectPath, redirectToSignIn } from "$lib/auth-redirect";
import { decideUnauthorizedRecovery } from "$lib/auth-unauthorized";
import { getClientInstanceId } from "$lib/client-instance";
import {
	registerSpaceOrigins,
	resolveSpaceOrigin,
	type SpaceOrigin,
} from "$lib/space-origin";
import { billingConversion } from "$lib/stores/billing-conversion.svelte";
import {
	createLocalNodeWebSocket,
	localNodeFetch,
} from "$lib/local-node-route";

type UnauthorizedContext = Parameters<
	NonNullable<CohubClientOptions["onUnauthorized"]>
>[0];

const handleUnauthorized = async (context: UnauthorizedContext) => {
	if (typeof window === "undefined") return;
	const rejectedSnapshot = getAuthSessionSnapshot();
	const rejectedGeneration =
		typeof context.authSessionVersion === "number"
			? context.authSessionVersion
			: rejectedSnapshot.generation;
	const decision = decideUnauthorizedRecovery({
		snapshot: rejectedSnapshot,
		rejectedGeneration,
		matchesRejectedToken: context.matchesRejectedToken,
	});
	const diagnostic = {
		event: "auth.unauthorized_recovery",
		action: decision.action,
		reason: decision.reason,
		authSessionGeneration: rejectedSnapshot.generation,
		rejectedAuthSessionGeneration: rejectedGeneration,
		authSessionAttempt: rejectedSnapshot.attempt,
		requestCredentialPresent: !context.matchesRejectedToken(null),
		cachedCredentialPresent: Boolean(rejectedSnapshot.token),
		lastResolutionSucceeded: rejectedSnapshot.lastResolutionSucceeded,
		...context.traceContext,
	};
	if (decision.action === "ignore") {
		console.info(
			"[auth] Ignored an unauthorized response that did not match the active session.",
			diagnostic,
		);
		return;
	}
	console.warn(
		"[auth] Recovering a session after a final unauthorized response.",
		diagnostic,
	);
	// Refresh already failed in transport — drop local Logto residue so the
	// next sign-in is a clean round-trip instead of a silent SSO bounce.
	await redirectToSignIn(getCurrentRedirectPath(), {
		clearSession: true,
		expectedGeneration: decision.expectedGeneration,
		rejectedToken: decision.rejectedToken,
	});
};

function shouldInspectBillingResponse(
	input: RequestInfo | URL,
	response: Response,
) {
	if (response.status === 402) return true;
	const url =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.pathname
				: input.url;
	return (
		response.status < 300 &&
		/\/api\/(spaces\/[^/]+\/prompt|sessions\/[^/]+\/messages|generations)(?:[?#/]|$)/.test(
			url,
		)
	);
}

const createBillingAwareFetch =
	(fetcher: typeof fetch): typeof fetch =>
	async (input, init) => {
		const response = await fetcher(input, init);
		if (!shouldInspectBillingResponse(input, response)) return response;
		const contentType = response.headers.get("content-type") ?? "";
		if (!contentType.includes("application/json")) return response;
		const body = await response
			.clone()
			.json()
			.catch(() => null);
		if (body) billingConversion.handleResponseBody(body);
		return response;
	};

const createWebSdk = (options: Partial<CohubClientOptions> = {}) => {
	const baseFetch = options.fetch ?? fetch;
	return createCohubClient({
		baseUrl: options.baseUrl ?? PUBLIC_API_ORIGIN ?? "",
		getAccessToken: options.getAccessToken ?? resolveAccessToken,
		getAuthSessionVersion:
			options.getAuthSessionVersion ??
			(() => getAuthSessionSnapshot().generation),
		onUnauthorized: options.onUnauthorized ?? handleUnauthorized,
		setStoredAuthToken: options.setStoredAuthToken ?? setAuthToken,
		clearStoredAuthToken: options.clearStoredAuthToken ?? clearAuthToken,
		...options,
		// Stamp this tab's identity on every request so work it starts (prompts,
		// agent turns, sandbox CLI calls) can address this UI again later.
		requestSource:
			options.requestSource ??
			(() => {
				const clientId = getClientInstanceId();
				return { via: "web", ...(clientId ? { clientId } : {}) };
			}),
		fetch: createBillingAwareFetch(baseFetch),
		websocket: {
			url: PUBLIC_GATEWAY_ORIGIN ?? undefined,
			getAccessToken: resolveAccessToken,
			...options.websocket,
		},
		voice: {
			url: PUBLIC_GATEWAY_ORIGIN ?? undefined,
			getAccessToken: resolveAccessToken,
			...options.voice,
		},
	});
};

export const createWebClient = createWebSdk;

const localModeEnabled = env.PUBLIC_COHUB_LOCAL_MODE === "true";
const localGatewayUrl = PUBLIC_GATEWAY_ORIGIN ?? "";
const localSdk = localModeEnabled
	? createWebSdk({
			fetch: localNodeFetch,
			websocket: {
				url: localGatewayUrl || undefined,
				WebSocketImpl:
					typeof WebSocket === "undefined" || !localGatewayUrl
						? undefined
						: createLocalNodeWebSocket(localGatewayUrl),
			},
		})
	: createWebSdk();
const cloudSdk = localModeEnabled
	? createWebSdk({
			baseUrl: env.PUBLIC_CLOUD_API_ORIGIN?.trim() || "https://api.cohub.live",
			websocket: {
				url:
					env.PUBLIC_CLOUD_GATEWAY_ORIGIN?.trim() ||
					"wss://gateway.cohub.live/ws",
			},
			voice: {
				url:
					env.PUBLIC_CLOUD_GATEWAY_ORIGIN?.trim() ||
					"wss://gateway.cohub.live/asr/ws",
			},
		})
	: localSdk;

function tagSpaces(spaces: SpaceRecord[], origin: SpaceOrigin) {
	return spaces.map((space) => ({ ...space, origin }));
}

function createMergedSpacesApi() {
	return new Proxy(cloudSdk.spaces, {
		get(target, property, receiver) {
			if (property === "list") {
				return async (customFetch?: typeof fetch) => {
					const [localSpaces, cloudSpaces] = await Promise.all([
						localSdk.spaces.list(customFetch),
						cloudSdk.spaces.list(customFetch),
					]);
					const merged = [
						...tagSpaces(localSpaces, "local"),
						...tagSpaces(cloudSpaces, "cloud"),
					];
					registerSpaceOrigins(merged);
					return merged;
				};
			}
			if (property === "get") {
				return (spaceId: string, customFetch?: typeof fetch) =>
					sdkForSpaceOrigin(resolveSpaceOrigin(spaceId))
						.spaces.get(spaceId, customFetch)
						.then((space) => {
							const [tagged] = tagSpaces([space], resolveSpaceOrigin(spaceId));
							if (!tagged) throw new Error(`Space not found: ${spaceId}`);
							registerSpaceOrigins([tagged]);
							return tagged;
						});
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

const mergedSpaces = createMergedSpacesApi();

function createLocalModeSdk(): CohubClient {
	return new Proxy(cloudSdk, {
		get(target, property, receiver) {
			if (property === "spaces") return mergedSpaces;
			if (property === "space") {
				return (spaceId: string) =>
					sdkForSpaceOrigin(resolveSpaceOrigin(spaceId)).space(spaceId);
			}
			if (property === "onUserEvent") {
				return (handler: Parameters<CohubClient["onUserEvent"]>[0]) => {
					const offLocal = localSdk.onUserEvent(handler);
					const offCloud = cloudSdk.onUserEvent(handler);
					return () => {
						offLocal();
						offCloud();
					};
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export function sdkForSpaceOrigin(origin: SpaceOrigin): CohubClient {
	if (!localModeEnabled) return cloudSdk;
	return origin === "local" ? localSdk : cloudSdk;
}

export const sdk = localModeEnabled ? createLocalModeSdk() : cloudSdk;
