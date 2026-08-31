import type {
	NativeActivityRegistrationIdentity,
	NativeDeviceRegistrationIdentity,
} from "./relay-registration";
import { isNativeRegistrationId } from "./relay-registration";
import type { NativeActivitySpaceSource, NativePulseFocus } from "./types";

export type NativeActivityOrigin = "local" | "cloud";

export type NativeWatchedSpacePreference = {
	spaceId: string;
	origin: NativeActivityOrigin;
};

export type NativeFocusPreference = NativeWatchedSpacePreference & {
	sessionId: string | null;
	explicit: boolean;
};

export type NativeActivityPreferences = {
	watchedSpaces: NativeWatchedSpacePreference[];
	focus: NativeFocusPreference | null;
};

function catalogOrigin(
	spaces: NativeActivitySpaceSource[],
	spaceId: string,
): NativeActivityOrigin {
	const matches = spaces.filter((space) => space.id === spaceId);
	if (matches.length === 0) {
		throw new Error(
			`Space origin is missing from the native catalog: ${spaceId}`,
		);
	}
	const origins = new Set(matches.map((space) => space.origin));
	if (origins.size !== 1) {
		throw new Error(
			`Space origin is ambiguous in the native catalog: ${spaceId}`,
		);
	}
	const origin = matches[0]?.origin;
	if (origin !== "local" && origin !== "cloud") {
		throw new Error(
			`Space origin is invalid in the native catalog: ${spaceId}`,
		);
	}
	return origin;
}

export function buildNativeActivityPreferences(input: {
	spaces: NativeActivitySpaceSource[];
	watchedSpaceIds: string[];
	focus: NativePulseFocus | null;
}): NativeActivityPreferences {
	if (
		input.watchedSpaceIds.length > 3 ||
		new Set(input.watchedSpaceIds).size !== input.watchedSpaceIds.length
	) {
		throw new Error("Native activity watched Space set is malformed");
	}
	const watchedSpaces = input.watchedSpaceIds.map((spaceId) => {
		if (!isNativeRegistrationId(spaceId)) {
			throw new Error("Native activity watched Space identifier is malformed");
		}
		return { spaceId, origin: catalogOrigin(input.spaces, spaceId) };
	});
	if (
		input.focus &&
		(!isNativeRegistrationId(input.focus.spaceId) ||
			(input.focus.sessionId !== null &&
				!isNativeRegistrationId(input.focus.sessionId)) ||
			(input.focus.explicit && input.focus.sessionId === null))
	) {
		throw new Error("Native activity focus is malformed");
	}
	const focus = input.focus
		? {
				spaceId: input.focus.spaceId,
				origin: catalogOrigin(input.spaces, input.focus.spaceId),
				sessionId: input.focus.sessionId,
				explicit: input.focus.explicit,
			}
		: null;
	return { watchedSpaces, focus };
}

export function resolvePreferenceInstallationId(
	device: NativeDeviceRegistrationIdentity | null,
	activities: NativeActivityRegistrationIdentity[],
): string | null {
	const installationIds = new Set([
		...(device ? [device.installationId] : []),
		...activities.map((activity) => activity.installationId),
	]);
	if (installationIds.size > 1) {
		throw new Error("Native installation identity is inconsistent");
	}
	const installationId = [...installationIds][0] ?? null;
	if (installationId && !isNativeRegistrationId(installationId)) {
		throw new Error("Native installation identity is malformed");
	}
	return installationId;
}

export function preferenceRegistrationKey(
	installationId: string,
	preferences: NativeActivityPreferences,
) {
	return JSON.stringify({ installationId, preferences });
}
