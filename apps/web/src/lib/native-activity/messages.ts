import {
	NATIVE_ACTIVITY_SCHEMA_VERSION,
	type NativeActivitySnapshot,
} from "./types";

export function nativeSnapshotReplaceMessage(snapshot: NativeActivitySnapshot) {
	return {
		schemaVersion: NATIVE_ACTIVITY_SCHEMA_VERSION,
		type: "snapshot.replace" as const,
		snapshot,
	};
}

export function nativeActivityStartMessage(snapshot: NativeActivitySnapshot) {
	return {
		schemaVersion: NATIVE_ACTIVITY_SCHEMA_VERSION,
		type: "activity.start" as const,
		snapshot,
	};
}

export function nativeActivityEndMessage() {
	return {
		schemaVersion: NATIVE_ACTIVITY_SCHEMA_VERSION,
		type: "activity.end" as const,
	};
}

export function nativePushRegisterMessage() {
	return {
		schemaVersion: NATIVE_ACTIVITY_SCHEMA_VERSION,
		type: "push.register" as const,
	};
}

export function nativeStateResetMessage() {
	return {
		schemaVersion: NATIVE_ACTIVITY_SCHEMA_VERSION,
		type: "state.reset" as const,
	};
}
