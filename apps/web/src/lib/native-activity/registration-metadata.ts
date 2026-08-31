import {
	isNativePushEnvironment,
	isNativeRegistrationId,
	type NativeActivityRegistrationIdentity,
	type NativeDeviceRegistrationIdentity,
} from "./relay-registration";

type PersistedRegistrationMetadata = {
	version: 1;
	device: NativeDeviceRegistrationIdentity | null;
	activities: NativeActivityRegistrationIdentity[];
};

export function nativeRegistrationMetadataKey(userKey: string) {
	if (!userKey)
		throw new Error("Native registration metadata user key is missing");
	return `cohub:native-activity:registrations:${userKey}:v1`;
}

export function readNativeRegistrationMetadata(
	storage: Storage,
	key: string,
): PersistedRegistrationMetadata {
	const raw = storage.getItem(key);
	if (raw === null) return { version: 1, device: null, activities: [] };
	const value: unknown = JSON.parse(raw);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Native registration metadata is malformed");
	}
	const record = value as Record<string, unknown>;
	if (
		record.version !== 1 ||
		!Array.isArray(record.activities) ||
		Object.keys(record).some(
			(key) => !["version", "device", "activities"].includes(key),
		)
	) {
		throw new Error("Native registration metadata is malformed");
	}
	const parseDevice = (
		input: unknown,
		allowActivityId = false,
	): NativeDeviceRegistrationIdentity | null => {
		if (input === null) return null;
		if (!input || typeof input !== "object" || Array.isArray(input)) {
			throw new Error("Native registration metadata is malformed");
		}
		const item = input as Record<string, unknown>;
		const allowedKeys = allowActivityId
			? ["installationId", "activityId", "environment"]
			: ["installationId", "environment"];
		if (Object.keys(item).some((key) => !allowedKeys.includes(key))) {
			throw new Error("Native registration metadata is malformed");
		}
		if (!isNativeRegistrationId(item.installationId)) {
			throw new Error("Native registration metadata is malformed");
		}
		if (
			item.environment !== undefined &&
			!isNativePushEnvironment(item.environment)
		) {
			throw new Error("Native registration metadata is malformed");
		}
		return {
			installationId: item.installationId,
			...(item.environment ? { environment: item.environment } : {}),
		};
	};
	const device = parseDevice(record.device);
	const activities = record.activities.map(
		(input): NativeActivityRegistrationIdentity => {
			const deviceIdentity = parseDevice(input, true);
			if (!deviceIdentity || !input || typeof input !== "object") {
				throw new Error("Native registration metadata is malformed");
			}
			const activityId = (input as Record<string, unknown>).activityId;
			if (!isNativeRegistrationId(activityId)) {
				throw new Error("Native registration metadata is malformed");
			}
			return { ...deviceIdentity, activityId };
		},
	);
	if (
		new Set(activities.map((item) => item.activityId)).size !==
		activities.length
	) {
		throw new Error("Native registration metadata is malformed");
	}
	return { version: 1, device, activities };
}

export function writeNativeRegistrationMetadata(
	storage: Storage,
	key: string,
	metadata: Omit<PersistedRegistrationMetadata, "version">,
) {
	const value: PersistedRegistrationMetadata = {
		version: 1,
		device: metadata.device
			? {
					installationId: metadata.device.installationId,
					...(metadata.device.environment
						? { environment: metadata.device.environment }
						: {}),
				}
			: null,
		activities: metadata.activities.map((item) => ({
			installationId: item.installationId,
			activityId: item.activityId,
			...(item.environment ? { environment: item.environment } : {}),
		})),
	};
	storage.setItem(key, JSON.stringify(value));
}
