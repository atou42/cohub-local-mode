import { importPKCS8, SignJWT } from "jose";
import {
	assertActivityPushPayloadSize,
	classifyApnsResponse,
	type ActivityPushPayload,
} from "./activity.ts";

export type ApnsEnvironment = "development" | "production";

export type ApnsConfig = {
	teamId: string;
	keyId: string;
	privateKey: string;
	environment: ApnsEnvironment;
	topic: string;
	attributesType: string;
};

export function parseApnsRetryAfter(value: string | null, nowMs = Date.now()) {
	if (!value) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
	const dateMs = Date.parse(value);
	return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : null;
}

export class ApnsConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ApnsConfigurationError";
	}
}

export function apnsHost(environment: ApnsEnvironment) {
	return environment === "development"
		? "https://api.sandbox.push.apple.com"
		: "https://api.push.apple.com";
}

export function validateApnsConfig(value: Partial<ApnsConfig>): ApnsConfig {
	for (const name of [
		"teamId",
		"keyId",
		"privateKey",
		"topic",
		"attributesType",
	] as const) {
		if (typeof value[name] !== "string" || !value[name]?.trim()) {
			throw new ApnsConfigurationError(`Missing APNs setting: ${name}`);
		}
	}
	if (value.environment !== "development" && value.environment !== "production") {
		throw new ApnsConfigurationError(
			"APNs environment must be development or production",
		);
	}
	if (!value.topic?.endsWith(".push-type.liveactivity")) {
		throw new ApnsConfigurationError(
			"APNs topic must be the fixed live activity topic",
		);
	}
	const teamId = value.teamId as string;
	const keyId = value.keyId as string;
	const privateKey = value.privateKey as string;
	const attributesType = value.attributesType as string;
	return {
		teamId: teamId.trim(),
		keyId: keyId.trim(),
		privateKey: privateKey.replaceAll("\\n", "\n").trim(),
		environment: value.environment,
		topic: value.topic.trim(),
		attributesType: attributesType.trim(),
	};
}

export async function createApnsProviderToken(
	config: ApnsConfig,
	nowMs = Date.now(),
) {
	const privateKey = await importPKCS8(config.privateKey, "ES256");
	return new SignJWT({})
		.setProtectedHeader({ alg: "ES256", kid: config.keyId })
		.setIssuer(config.teamId)
		.setIssuedAt(Math.floor(nowMs / 1_000))
		.sign(privateKey);
}

async function readApnsReason(response: Response) {
	if (response.status === 200) return null;
	const body = await response.text();
	if (!body) return null;
	try {
		const parsed = JSON.parse(body) as { reason?: unknown };
		return typeof parsed.reason === "string" ? parsed.reason : null;
	} catch {
		return null;
	}
}

export async function sendActivityPush(input: {
	config: ApnsConfig;
	deviceToken: string;
	payload: ActivityPushPayload;
	providerToken: string;
	apnsRequestId: string;
	fetcher?: typeof fetch;
}) {
	assertActivityPushPayloadSize(input.payload);
	const fetcher = input.fetcher ?? fetch;
	const response = await fetcher(
		`${apnsHost(input.config.environment)}/3/device/${input.deviceToken}`,
		{
			method: "POST",
				headers: {
				authorization: `bearer ${input.providerToken}`,
				"apns-priority": "10",
				"apns-push-type": "liveactivity",
					"apns-topic": input.config.topic,
					"apns-id": input.apnsRequestId,
				"content-type": "application/json",
			},
			body: JSON.stringify(input.payload),
		},
	);
	const reason = await readApnsReason(response);
	return {
		status: response.status,
		reason,
		disposition: classifyApnsResponse(response.status, reason),
		apnsId: response.headers.get("apns-id"),
		retryAfterMs: parseApnsRetryAfter(response.headers.get("retry-after")),
	};
}
