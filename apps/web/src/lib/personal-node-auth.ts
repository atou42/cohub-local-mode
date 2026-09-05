export const PERSONAL_NODE_AUTH_STORAGE_KEY =
	"cohub:personal-node-auth-session:v1";

const EXPIRY_SKEW_MS = 60_000;

export type PersonalNodeAuthSession = {
	schemaVersion: 1;
	accessToken: string;
	refreshToken: string;
	idToken?: string;
	tokenType: "Bearer";
	scope: string;
	accessTokenExpiresAt: number;
	createdAt: number;
	updatedAt: number;
};

export type PersonalNodeDeviceAuthorization = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	expiresInSeconds: number;
	intervalSeconds: number;
};

type TokenPayload = {
	status: "complete";
	accessToken: string;
	refreshToken?: string;
	idToken?: string;
	tokenType: "Bearer";
	expiresInSeconds: number;
	scope: string;
};

export class PersonalNodeAuthError extends Error {
	readonly code: string;
	readonly status?: number;

	constructor(message: string, code: string, status?: number) {
		super(message);
		this.name = "PersonalNodeAuthError";
		this.code = code;
		this.status = status;
	}
}

function storageOrThrow(storage?: Storage) {
	const target = storage ?? globalThis.localStorage;
	if (!target) {
		throw new PersonalNodeAuthError(
			"Browser storage is unavailable",
			"personal_node_auth_storage_unavailable",
		);
	}
	return target;
}

function requiredString(value: unknown, field: string, maxLength = 16_384) {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > maxLength ||
		/[\r\n\0]/.test(value)
	) {
		throw new PersonalNodeAuthError(
			`Authentication data has an invalid ${field}`,
			"personal_node_auth_data_invalid",
		);
	}
	return value.trim();
}

function requiredPositiveNumber(value: unknown, field: string) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new PersonalNodeAuthError(
			`Authentication data has an invalid ${field}`,
			"personal_node_auth_data_invalid",
		);
	}
	return value;
}

function optionalString(value: unknown, field: string) {
	return value === undefined ? undefined : requiredString(value, field);
}

function parseSession(value: unknown): PersonalNodeAuthSession {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new PersonalNodeAuthError(
			"Stored authentication data is invalid",
			"personal_node_auth_state_corrupt",
		);
	}
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 1 || record.tokenType !== "Bearer") {
		throw new PersonalNodeAuthError(
			"Stored authentication data is invalid",
			"personal_node_auth_state_corrupt",
		);
	}
	const createdAt = requiredPositiveNumber(record.createdAt, "createdAt");
	const updatedAt = requiredPositiveNumber(record.updatedAt, "updatedAt");
	const accessTokenExpiresAt = requiredPositiveNumber(
		record.accessTokenExpiresAt,
		"accessTokenExpiresAt",
	);
	return {
		schemaVersion: 1,
		accessToken: requiredString(record.accessToken, "accessToken"),
		refreshToken: requiredString(record.refreshToken, "refreshToken"),
		...(record.idToken === undefined
			? {}
			: { idToken: optionalString(record.idToken, "idToken") }),
		tokenType: "Bearer",
		scope: requiredString(record.scope, "scope", 1_024),
		accessTokenExpiresAt,
		createdAt,
		updatedAt,
	};
}

function parseDeviceAuthorization(
	value: unknown,
): PersonalNodeDeviceAuthorization {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new PersonalNodeAuthError(
			"Device authorization response is invalid",
			"personal_node_auth_data_invalid",
		);
	}
	const record = value as Record<string, unknown>;
	const verificationUri = requiredString(
		record.verificationUri,
		"verificationUri",
		4_096,
	);
	const verificationUriComplete = requiredString(
		record.verificationUriComplete,
		"verificationUriComplete",
		4_096,
	);
	for (const uri of [verificationUri, verificationUriComplete]) {
		if (new URL(uri).protocol !== "https:") {
			throw new PersonalNodeAuthError(
				"Device authorization URL must use HTTPS",
				"personal_node_auth_data_invalid",
			);
		}
	}
	return {
		deviceCode: requiredString(record.deviceCode, "deviceCode", 4_096),
		userCode: requiredString(record.userCode, "userCode", 64),
		verificationUri,
		verificationUriComplete,
		expiresInSeconds: requiredPositiveNumber(
			record.expiresInSeconds,
			"expiresInSeconds",
		),
		intervalSeconds: requiredPositiveNumber(
			record.intervalSeconds,
			"intervalSeconds",
		),
	};
}

function parseTokenPayload(value: unknown): TokenPayload {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new PersonalNodeAuthError(
			"Token response is invalid",
			"personal_node_auth_data_invalid",
		);
	}
	const record = value as Record<string, unknown>;
	if (record.status !== "complete" || record.tokenType !== "Bearer") {
		throw new PersonalNodeAuthError(
			"Token response is invalid",
			"personal_node_auth_data_invalid",
		);
	}
	return {
		status: "complete",
		accessToken: requiredString(record.accessToken, "accessToken"),
		...(record.refreshToken === undefined
			? {}
			: {
					refreshToken: optionalString(record.refreshToken, "refreshToken"),
				}),
		...(record.idToken === undefined
			? {}
			: { idToken: optionalString(record.idToken, "idToken") }),
		tokenType: "Bearer",
		expiresInSeconds: requiredPositiveNumber(
			record.expiresInSeconds,
			"expiresInSeconds",
		),
		scope: requiredString(record.scope, "scope", 1_024),
	};
}

async function errorFromResponse(response: Response) {
	const body = (await response.json().catch(() => null)) as {
		code?: unknown;
		message?: unknown;
	} | null;
	return new PersonalNodeAuthError(
		typeof body?.message === "string"
			? body.message
			: `Authentication request failed (${response.status})`,
		typeof body?.code === "string"
			? body.code
			: "personal_node_auth_request_failed",
		response.status,
	);
}

function authUrl(apiOrigin: string, path: string) {
	const base = apiOrigin.trim().replace(/\/+$/, "");
	return `${base}${path}`;
}

export function readPersonalNodeAuthSession(
	storage?: Storage,
): PersonalNodeAuthSession | null {
	const raw = storageOrThrow(storage).getItem(PERSONAL_NODE_AUTH_STORAGE_KEY);
	if (raw === null) return null;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new PersonalNodeAuthError(
			"Stored authentication data is corrupt",
			"personal_node_auth_state_corrupt",
		);
	}
	return parseSession(value);
}

export function writePersonalNodeAuthSession(
	session: PersonalNodeAuthSession,
	storage?: Storage,
) {
	const validated = parseSession(session);
	storageOrThrow(storage).setItem(
		PERSONAL_NODE_AUTH_STORAGE_KEY,
		JSON.stringify(validated),
	);
}

export function clearPersonalNodeAuthSession(storage?: Storage) {
	storageOrThrow(storage).removeItem(PERSONAL_NODE_AUTH_STORAGE_KEY);
}

export async function beginPersonalNodeDeviceAuthorization(
	apiOrigin: string,
	fetcher: typeof fetch = fetch,
) {
	const response = await fetcher(
		authUrl(apiOrigin, "/api/alpha/v1/auth/device"),
		{ method: "POST", credentials: "omit", cache: "no-store" },
	);
	if (!response.ok) throw await errorFromResponse(response);
	return parseDeviceAuthorization(await response.json());
}

export async function pollPersonalNodeDeviceAuthorization(
	apiOrigin: string,
	deviceCode: string,
	fetcher: typeof fetch = fetch,
): Promise<{ status: "pending" } | { status: "slow_down" } | TokenPayload> {
	const response = await fetcher(
		authUrl(apiOrigin, "/api/alpha/v1/auth/token"),
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ deviceCode }),
			credentials: "omit",
			cache: "no-store",
		},
	);
	if (response.status === 202) return { status: "pending" };
	if (response.status === 429) return { status: "slow_down" };
	if (!response.ok) throw await errorFromResponse(response);
	return parseTokenPayload(await response.json());
}

export function persistPersonalNodeToken(
	payload: TokenPayload,
	previous?: PersonalNodeAuthSession | null,
	storage?: Storage,
) {
	const now = Date.now();
	const refreshToken = payload.refreshToken ?? previous?.refreshToken;
	if (!refreshToken) {
		throw new PersonalNodeAuthError(
			"Authentication response did not include a refresh token",
			"personal_node_auth_data_invalid",
		);
	}
	const session: PersonalNodeAuthSession = {
		schemaVersion: 1,
		accessToken: payload.accessToken,
		refreshToken,
		...((payload.idToken ?? previous?.idToken)
			? { idToken: payload.idToken ?? previous?.idToken }
			: {}),
		tokenType: "Bearer",
		scope: payload.scope,
		accessTokenExpiresAt: now + payload.expiresInSeconds * 1_000,
		createdAt: previous?.createdAt ?? now,
		updatedAt: now,
	};
	writePersonalNodeAuthSession(session, storage);
	return session;
}

export async function resolvePersonalNodeAccessToken(input: {
	apiOrigin: string;
	forceRefresh: boolean;
	storage?: Storage;
	fetcher?: typeof fetch;
}) {
	const session = readPersonalNodeAuthSession(input.storage);
	if (!session) return null;
	if (
		!input.forceRefresh &&
		session.accessTokenExpiresAt > Date.now() + EXPIRY_SKEW_MS
	) {
		return session.accessToken;
	}
	const response = await (input.fetcher ?? fetch)(
		authUrl(input.apiOrigin, "/api/alpha/v1/auth/refresh"),
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ refreshToken: session.refreshToken }),
			credentials: "omit",
			cache: "no-store",
		},
	);
	if (response.status === 401) {
		clearPersonalNodeAuthSession(input.storage);
		return null;
	}
	if (!response.ok) throw await errorFromResponse(response);
	const next = persistPersonalNodeToken(
		parseTokenPayload(await response.json()),
		session,
		input.storage,
	);
	return next.accessToken;
}

export function getPersonalNodeIdToken(storage?: Storage) {
	return readPersonalNodeAuthSession(storage)?.idToken ?? null;
}
