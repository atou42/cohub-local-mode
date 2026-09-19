import type { NativeActivityPreferences } from "./preferences";
import { NATIVE_PUSH_ENVIRONMENTS, type NativePushEnvironment } from "./types";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[0-9a-f]+$/i;

export type NativeDeviceRegistrationIdentity = {
	installationId: string;
	environment?: NativePushEnvironment;
};

export type NativeActivityRegistrationIdentity =
	NativeDeviceRegistrationIdentity & {
		activityId: string;
	};

export type NativeTokenRegistration = NativeDeviceRegistrationIdentity & {
	token: string;
	environment: NativePushEnvironment;
};

export type NativeActivityTokenRegistration =
	NativeActivityRegistrationIdentity & NativeTokenRegistration;

export function isNativeRegistrationId(value: unknown): value is string {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isNativePushToken(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length >= 64 &&
		value.length <= 512 &&
		value.length % 2 === 0 &&
		TOKEN_PATTERN.test(value)
	);
}

export function isNativePushEnvironment(
	value: unknown,
): value is NativePushEnvironment {
	return (
		typeof value === "string" &&
		(NATIVE_PUSH_ENVIRONMENTS as readonly string[]).includes(value)
	);
}

export function resolveNativeTokenEventEnvironment(
	value: unknown,
):
	| { accepted: true; environment: NativePushEnvironment; stale: false }
	| { accepted: false; environment: null; stale: true } {
	return isNativePushEnvironment(value)
		? { accepted: true, environment: value, stale: false }
		: { accepted: false, environment: null, stale: true };
}

function assertRegistrationIds(ids: string[]) {
	if (ids.some((id) => !isNativeRegistrationId(id))) {
		throw new Error(
			"Native activity registration contains an invalid identifier",
		);
	}
}

function hasExactKeys(value: object, keys: string[]) {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return (
		actual.length === expected.length &&
		actual.every((key, index) => key === expected[index])
	);
}

function assertPreferences(preferences: NativeActivityPreferences) {
	if (
		!hasExactKeys(preferences, ["watchedSpaces", "focus"]) ||
		preferences.watchedSpaces.length > 3 ||
		preferences.watchedSpaces.some(
			(space) =>
				!hasExactKeys(space, ["spaceId", "origin"]) ||
				!isNativeRegistrationId(space.spaceId) ||
				(space.origin !== "local" && space.origin !== "cloud"),
		)
	) {
		throw new Error("Native activity preferences are malformed");
	}
	const watchedKeys = preferences.watchedSpaces.map(
		(space) => `${space.origin}\0${space.spaceId}`,
	);
	if (new Set(watchedKeys).size !== watchedKeys.length) {
		throw new Error("Native activity preferences are malformed");
	}
	const focus = preferences.focus;
	if (
		focus &&
		(!hasExactKeys(focus, ["spaceId", "origin", "sessionId", "explicit"]) ||
			!isNativeRegistrationId(focus.spaceId) ||
			(focus.origin !== "local" && focus.origin !== "cloud") ||
			typeof focus.explicit !== "boolean" ||
			(focus.sessionId !== null && !isNativeRegistrationId(focus.sessionId)) ||
			(focus.explicit && focus.sessionId === null))
	) {
		throw new Error("Native activity preferences are malformed");
	}
}

async function requestRegistration(
	path: string,
	init: RequestInit,
	fetcher: typeof fetch,
) {
	const response = await fetcher(path, {
		...init,
		credentials: "same-origin",
		headers: {
			...(init.body ? { "Content-Type": "application/json" } : {}),
			...init.headers,
		},
	});
	if (!response.ok) {
		throw new Error(`Native activity registration failed (${response.status})`);
	}
}

export function createNativeRelayRegistrationAdapter(
	fetcher: typeof fetch = fetch,
) {
	return {
		async putDevice(registration: NativeTokenRegistration) {
			assertRegistrationIds([registration.installationId]);
			if (!isNativePushToken(registration.token)) {
				throw new Error("Native push-to-start token is malformed");
			}
			if (!isNativePushEnvironment(registration.environment)) {
				throw new Error("Native push environment is malformed");
			}
			await requestRegistration(
				`/relay/v1/nodes/mac-mini/activity/devices/${encodeURIComponent(registration.installationId)}`,
				{
					method: "PUT",
					body: JSON.stringify({
						token: registration.token,
						environment: registration.environment,
					}),
				},
				fetcher,
			);
		},

		async deleteDevice(installationId: string) {
			assertRegistrationIds([installationId]);
			await requestRegistration(
				`/relay/v1/nodes/mac-mini/activity/devices/${encodeURIComponent(installationId)}`,
				{ method: "DELETE" },
				fetcher,
			);
		},

		async putActivity(registration: NativeActivityTokenRegistration) {
			assertRegistrationIds([
				registration.installationId,
				registration.activityId,
			]);
			if (!isNativePushToken(registration.token)) {
				throw new Error("Native activity token is malformed");
			}
			if (!isNativePushEnvironment(registration.environment)) {
				throw new Error("Native push environment is malformed");
			}
			await requestRegistration(
				`/relay/v1/nodes/mac-mini/activity/registrations/${encodeURIComponent(registration.installationId)}/${encodeURIComponent(registration.activityId)}`,
				{
					method: "PUT",
					body: JSON.stringify({
						token: registration.token,
						environment: registration.environment,
					}),
				},
				fetcher,
			);
		},

		async putPreferences(
			installationId: string,
			preferences: NativeActivityPreferences,
		) {
			assertRegistrationIds([installationId]);
			assertPreferences(preferences);
			await requestRegistration(
				`/relay/v1/nodes/mac-mini/activity/preferences/${encodeURIComponent(installationId)}`,
				{
					method: "PUT",
					body: JSON.stringify(preferences),
				},
				fetcher,
			);
		},

		async deletePreferences(installationId: string) {
			assertRegistrationIds([installationId]);
			await requestRegistration(
				`/relay/v1/nodes/mac-mini/activity/preferences/${encodeURIComponent(installationId)}`,
				{ method: "DELETE" },
				fetcher,
			);
		},

		async deleteActivity(installationId: string, activityId: string) {
			assertRegistrationIds([installationId, activityId]);
			await requestRegistration(
				`/relay/v1/nodes/mac-mini/activity/registrations/${encodeURIComponent(installationId)}/${encodeURIComponent(activityId)}`,
				{ method: "DELETE" },
				fetcher,
			);
		},
	};
}

export type NativeRelayRegistrationAdapter = ReturnType<
	typeof createNativeRelayRegistrationAdapter
>;
