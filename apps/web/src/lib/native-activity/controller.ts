import type { ChannelEnvelope } from "@cohub/protocol/realtime";
import type {
	SessionRecord,
	SpaceRecord,
	SpaceTurnListItem,
} from "@neta-art/cohub";
import { sdk, sdkForSpaceOrigin } from "$lib/sdk";
import {
	getCachedSpaceList,
	onSpaceListCacheUpdated,
	setCachedSpaceList,
} from "$lib/stores/space-list-cache";
import {
	NativeStateResetAcknowledger,
	resetNativeAccountState,
} from "./account-reset";
import {
	DirtyAsyncCoordinator,
	NativeRegistrationHeartbeat,
	ProjectionRegistrationCoordinator,
	runWithBoundedRetry,
} from "./async-coordination";
import { registerAuthInvalidationCleanup } from "./auth-invalidation";
import { requireNativeDisplayName } from "./display-name";
import {
	nativeActivityEndMessage,
	nativeActivityStartMessage,
	nativePushRegisterMessage,
	nativeSnapshotReplaceMessage,
} from "./messages";
import {
	buildNativeActivityPreferences,
	type NativeActivityPreferences,
	preferenceRegistrationKey,
	resolvePreferenceInstallationId,
} from "./preferences";
import {
	applyNativeActivityTurn,
	buildNativeActivitySnapshot,
	getFocusedActiveTurn,
	parseNativeActivityTurn,
	parseTurnRealtimeEvent,
	reconcilePinnedSpaceOrder,
	resolveNativeFreshness,
	selectNativePulseFocus,
} from "./projection";
import {
	nativeRegistrationMetadataKey,
	readNativeRegistrationMetadata,
	writeNativeRegistrationMetadata,
} from "./registration-metadata";
import {
	createNativeRelayRegistrationAdapter,
	isNativePushToken,
	isNativeRegistrationId,
	type NativeActivityRegistrationIdentity,
	type NativeActivityTokenRegistration,
	type NativeDeviceRegistrationIdentity,
	type NativeRelayRegistrationAdapter,
	type NativeTokenRegistration,
	resolveNativeTokenEventEnvironment,
} from "./relay-registration";
import type {
	ExplicitNativeFocus,
	NativeActivitySnapshot,
	NativeActivitySpaceSource,
	NativeActivityTurn,
	NativeFocusViewState,
	NativePulseFocus,
} from "./types";

const PIN_ORDER_STORAGE_VERSION = 1;
const FOCUS_STORAGE_VERSION = 1;
const REVISION_STORAGE_VERSION = 1;
const SPACE_TURN_PAGE_LIMIT = 100;

type NativeMessageHandler = { postMessage(message: unknown): void };

declare global {
	interface Window {
		__COHUB_NATIVE__?: unknown;
		webkit?: {
			messageHandlers?: Record<string, NativeMessageHandler | undefined>;
		};
	}
}

type ConnectionState =
	| "idle"
	| "connecting"
	| "reconnecting"
	| "open"
	| "closed"
	| "error";

type NativeEventDetail = {
	schemaVersion: number;
	type: string;
	installationId?: unknown;
	activityId?: unknown;
	token?: unknown;
	environment?: unknown;
};

type BufferedTurnEvent = {
	sequence: number;
	turn: NativeActivityTurn;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseStoredStringArray(storage: Storage, key: string): string[] {
	const raw = storage.getItem(key);
	if (raw === null) return [];
	const value: unknown = JSON.parse(raw);
	if (
		!Array.isArray(value) ||
		value.some((item) => typeof item !== "string" || !item)
	) {
		throw new Error(`Native activity storage is malformed: ${key}`);
	}
	return value;
}

function parseStoredFocus(
	storage: Storage,
	key: string,
): ExplicitNativeFocus | null {
	const raw = storage.getItem(key);
	if (raw === null) return null;
	const value: unknown = JSON.parse(raw);
	if (
		!isRecord(value) ||
		value.explicit !== true ||
		typeof value.spaceId !== "string" ||
		!value.spaceId ||
		typeof value.sessionId !== "string" ||
		!value.sessionId
	) {
		throw new Error(`Native activity storage is malformed: ${key}`);
	}
	return {
		spaceId: value.spaceId,
		sessionId: value.sessionId,
		explicit: true,
	};
}

function parseStoredRevision(storage: Storage, key: string): number {
	const raw = storage.getItem(key);
	if (raw === null) return 0;
	const value: unknown = JSON.parse(raw);
	if (!Number.isSafeInteger(value) || Number(value) < 0) {
		throw new Error(`Native activity storage is malformed: ${key}`);
	}
	return Number(value);
}

function snapshotIdentity(snapshot: NativeActivitySnapshot) {
	return JSON.stringify({
		...snapshot,
		revision: 0,
		generatedAt: "",
	});
}

function spaceSource(space: SpaceRecord): NativeActivitySpaceSource {
	if (space.origin !== "local" && space.origin !== "cloud") {
		throw new Error(`Space origin is missing or invalid: ${space.id}`);
	}
	const displayName = requireNativeDisplayName(
		space.name ?? space.title,
		"Space display name",
	);
	return {
		id: space.id,
		name: displayName,
		origin: space.origin,
		isPinned: space.isPinned === true,
	};
}

function postNativeMessage(message: unknown): boolean {
	if (typeof window === "undefined" || !window.__COHUB_NATIVE__) return false;
	const handler = window.webkit?.messageHandlers?.cohubActivity;
	if (!handler) return false;
	handler.postMessage(message);
	return true;
}

function activityKey(turn: NativeActivityTurn | null) {
	return turn ? `${turn.spaceId}\0${turn.sessionId}\0${turn.id}` : "";
}

let registeredController: NativeActivityController | null = null;
let focusViewState: NativeFocusViewState = {
	enabled: false,
	explicitFocus: null,
};
const focusViewListeners = new Set<(state: NativeFocusViewState) => void>();

function publishFocusViewState(state: NativeFocusViewState) {
	focusViewState = state;
	for (const listener of focusViewListeners) listener(state);
}

export function getNativeFocusViewState(): NativeFocusViewState {
	return focusViewState;
}

export function subscribeNativeFocusViewState(
	listener: (state: NativeFocusViewState) => void,
) {
	focusViewListeners.add(listener);
	listener(focusViewState);
	return () => focusViewListeners.delete(listener);
}

export function toggleNativeSessionFocus(spaceId: string, sessionId: string) {
	if (!registeredController) return;
	registeredController.toggleExplicitFocus(spaceId, sessionId);
}

export function isNativeActivityHost() {
	return typeof window !== "undefined" && Boolean(window.__COHUB_NATIVE__);
}

export class NativeActivityController {
	private readonly pinOrderStorageKey: string;
	private readonly focusStorageKey: string;
	private readonly revisionStorageKey: string;
	private readonly registrationMetadataStorageKey: string;
	private readonly relay: NativeRelayRegistrationAdapter;
	private readonly disposers: Array<() => void> = [];
	private readonly spaceDisposers = new Map<string, () => void>();
	private readonly turnsBySpace = new Map<string, NativeActivityTurn[]>();
	private readonly bufferedEventsBySpace = new Map<
		string,
		BufferedTurnEvent[]
	>();
	private readonly activityTokens = new Map<
		string,
		NativeActivityTokenRegistration
	>();
	private spaces: NativeActivitySpaceSource[] = [];
	private watchedSpaceIds: string[];
	private explicitFocus: ExplicitNativeFocus | null;
	private currentRouteSpaceId: string | null = null;
	private eventSequence = 0;
	private revision: number;
	private lastSnapshotIdentity = "";
	private lastActivityKey = "";
	private readonly connectionStates: Record<
		"local" | "cloud",
		ConnectionState
	> = {
		local: "connecting",
		cloud: "connecting",
	};
	private online = navigator.onLine;
	private reconciling = true;
	private hasReconciled = false;
	private readonly reconcileErrors = new Set<string>();
	private snapshotReady = false;
	private scheduled = false;
	private stopped = false;
	private resetting = false;
	private resetPromise: Promise<void> | null = null;
	private readonly reconcileCoordinator = new DirtyAsyncCoordinator();
	private readonly registrationHeartbeat = new NativeRegistrationHeartbeat();
	private readonly stateResetAcknowledger = new NativeStateResetAcknowledger();
	private readonly registrationCoordinator =
		new ProjectionRegistrationCoordinator({
			maxAttempts: 3,
			baseDelayMs: 250,
		});
	private readonly preferenceCoordinator =
		new ProjectionRegistrationCoordinator({
			maxAttempts: 3,
			baseDelayMs: 250,
		});
	private readonly registrationAbortController = new AbortController();
	private deviceToken: NativeTokenRegistration | null = null;
	private deviceRegistrationIdentity: NativeDeviceRegistrationIdentity | null;
	private readonly activityRegistrationIdentities = new Map<
		string,
		NativeActivityRegistrationIdentity
	>();
	private readonly registrationErrors = new Set<string>();
	private readonly pendingRegistrationOperations = new Set<Promise<boolean>>();

	constructor(
		private readonly storage: Storage,
		userKey: string,
		relay = createNativeRelayRegistrationAdapter(),
	) {
		this.pinOrderStorageKey = `cohub:native-activity:pins:${userKey}:v${PIN_ORDER_STORAGE_VERSION}`;
		this.focusStorageKey = `cohub:native-activity:focus:${userKey}:v${FOCUS_STORAGE_VERSION}`;
		this.revisionStorageKey = `cohub:native-activity:revision:${userKey}:v${REVISION_STORAGE_VERSION}`;
		this.registrationMetadataStorageKey =
			nativeRegistrationMetadataKey(userKey);
		this.relay = relay;
		this.watchedSpaceIds = parseStoredStringArray(
			storage,
			this.pinOrderStorageKey,
		);
		this.explicitFocus = parseStoredFocus(storage, this.focusStorageKey);
		this.revision = parseStoredRevision(storage, this.revisionStorageKey);
		const registrationMetadata = readNativeRegistrationMetadata(
			storage,
			this.registrationMetadataStorageKey,
		);
		this.deviceRegistrationIdentity = registrationMetadata.device;
		for (const activity of registrationMetadata.activities) {
			this.activityRegistrationIdentities.set(activity.activityId, activity);
		}
	}

	start() {
		if (this.stopped) return;
		registeredController = this;
		this.disposers.push(
			registerAuthInvalidationCleanup(() => this.resetForAccountExit()),
		);
		publishFocusViewState({
			enabled: true,
			explicitFocus: this.explicitFocus,
		});
		const cached = getCachedSpaceList();
		if (cached) this.applySpaceList(cached);

		this.disposers.push(
			onSpaceListCacheUpdated(({ spaces }) => this.applySpaceList(spaces)),
			sdk.onUserEvent((event) => this.handleUserEvent(event)),
			sdkForSpaceOrigin("local").onConnection((state) =>
				this.handleConnection("local", state.state as ConnectionState),
			),
			sdkForSpaceOrigin("cloud").onConnection((state) =>
				this.handleConnection("cloud", state.state as ConnectionState),
			),
		);

		const handleOnline = () => {
			this.online = true;
			void this.refreshRelayRegistrations();
			void this.reconcileAll();
		};
		const handleOffline = () => {
			this.online = false;
			this.reconciling = false;
			this.scheduleProjection();
		};
		const handleNativeEvent = (event: Event) =>
			this.handleNativeEvent((event as CustomEvent<unknown>).detail);
		window.addEventListener("online", handleOnline);
		window.addEventListener("offline", handleOffline);
		window.addEventListener("cohub:native", handleNativeEvent);
		this.registrationHeartbeat.start({
			isEligible: () => this.online && !this.stopped && !this.resetting,
			refresh: () => this.refreshRelayRegistrations(),
		});
		this.disposers.push(() => {
			window.removeEventListener("online", handleOnline);
			window.removeEventListener("offline", handleOffline);
			window.removeEventListener("cohub:native", handleNativeEvent);
		});

		void this.refreshSpacesAndReconcile();
	}

	stop() {
		if (this.stopped) return;
		this.stopped = true;
		this.reconcileCoordinator.stop();
		this.registrationCoordinator.stop();
		this.preferenceCoordinator.stop();
		this.registrationAbortController.abort();
		this.registrationHeartbeat.stop();
		this.stateResetAcknowledger.stop();
		for (const dispose of this.disposers.splice(0)) dispose();
		for (const dispose of this.spaceDisposers.values()) dispose();
		this.spaceDisposers.clear();
		if (registeredController === this) registeredController = null;
		publishFocusViewState({ enabled: false, explicitFocus: null });
	}

	resetForAccountExit() {
		if (this.resetPromise) return this.resetPromise;
		let preferenceInstallationId: string | null;
		try {
			preferenceInstallationId = this.preferenceInstallationId();
		} catch (error) {
			return Promise.reject(error);
		}
		this.resetting = true;
		this.registrationHeartbeat.stop();
		this.registrationAbortController.abort();
		const registrationsSettled = Promise.all([
			this.registrationCoordinator.stop(),
			this.preferenceCoordinator.stop(),
			Promise.allSettled([...this.pendingRegistrationOperations]),
		]);
		this.resetPromise = registrationsSettled
			.then(() =>
				resetNativeAccountState({
					preferenceInstallationId,
					device: this.deviceRegistrationIdentity,
					activities: [...this.activityRegistrationIdentities.values()],
					relay: this.relay,
					resetNativeState: () =>
						this.stateResetAcknowledger.request((message) => {
							if (!postNativeMessage(message)) {
								throw new Error("Native activity reset bridge is unavailable");
							}
						}),
				}),
			)
			.then(() => {
				this.deviceToken = null;
				this.activityTokens.clear();
				this.deviceRegistrationIdentity = null;
				this.activityRegistrationIdentities.clear();
				this.storage.removeItem(this.registrationMetadataStorageKey);
				this.stop();
			})
			.catch((error) => {
				this.resetPromise = null;
				throw error;
			});
		return this.resetPromise;
	}

	setCurrentRoute(spaceId: string | null) {
		if (spaceId === this.currentRouteSpaceId) return;
		this.currentRouteSpaceId = spaceId;
		this.syncSpaceSubscriptions();
		void this.reconcileAll();
		void this.updateRelayPreferences();
		this.scheduleProjection();
	}

	toggleExplicitFocus(spaceId: string, sessionId: string) {
		const isCurrent =
			this.explicitFocus?.spaceId === spaceId &&
			this.explicitFocus.sessionId === sessionId;
		this.explicitFocus = isCurrent
			? null
			: { spaceId, sessionId, explicit: true };
		if (this.explicitFocus) {
			this.storage.setItem(
				this.focusStorageKey,
				JSON.stringify(this.explicitFocus),
			);
		} else {
			this.storage.removeItem(this.focusStorageKey);
		}
		publishFocusViewState({
			enabled: true,
			explicitFocus: this.explicitFocus,
		});
		this.syncSpaceSubscriptions();
		void this.reconcileAll();
		void this.updateRelayPreferences();
		this.scheduleProjection();
	}

	private async refreshSpacesAndReconcile() {
		try {
			const spaces = await sdk.spaces.list();
			this.reconcileErrors.delete("space-list");
			setCachedSpaceList(spaces);
			this.applySpaceList(spaces);
		} catch {
			this.reconcileErrors.add("space-list");
			console.error("[native-activity] Space refresh failed");
		}
		await this.reconcileAll();
	}

	private applySpaceList(spaces: SpaceRecord[]) {
		try {
			this.spaces = spaces.map(spaceSource);
			this.reconcileErrors.delete("space-catalog");
		} catch {
			this.reconcileErrors.add("space-catalog");
			console.error("[native-activity] Space catalog rejected");
			this.scheduleProjection();
			return;
		}
		const nextOrder = reconcilePinnedSpaceOrder(this.watchedSpaceIds, spaces);
		if (JSON.stringify(nextOrder) !== JSON.stringify(this.watchedSpaceIds)) {
			this.watchedSpaceIds = nextOrder;
			this.storage.setItem(
				this.pinOrderStorageKey,
				JSON.stringify(this.watchedSpaceIds),
			);
		}
		this.syncSpaceSubscriptions();
		void this.updateRelayPreferences();
		this.scheduleProjection();
	}

	private trackedSpaceIds() {
		const ids = [...this.watchedSpaceIds];
		if (
			this.explicitFocus?.spaceId &&
			!ids.includes(this.explicitFocus.spaceId)
		) {
			ids.push(this.explicitFocus.spaceId);
		}
		if (this.currentRouteSpaceId && !ids.includes(this.currentRouteSpaceId)) {
			ids.push(this.currentRouteSpaceId);
		}
		return ids;
	}

	private syncSpaceSubscriptions() {
		const tracked = new Set(this.trackedSpaceIds());
		for (const [spaceId, dispose] of this.spaceDisposers) {
			if (tracked.has(spaceId)) continue;
			dispose();
			this.spaceDisposers.delete(spaceId);
			this.turnsBySpace.delete(spaceId);
			this.bufferedEventsBySpace.delete(spaceId);
		}
		for (const spaceId of tracked) {
			if (this.spaceDisposers.has(spaceId)) continue;
			try {
				this.spaceDisposers.set(
					spaceId,
					sdk
						.space(spaceId)
						.subscribe((event) => this.handleSpaceEvent(spaceId, event)),
				);
				this.reconcileErrors.delete(`subscription:${spaceId}`);
			} catch {
				this.reconcileErrors.add(`subscription:${spaceId}`);
				console.error("[native-activity] Space subscription failed");
			}
		}
	}

	private handleConnection(origin: "local" | "cloud", state: ConnectionState) {
		this.connectionStates[origin] = state;
		if (state === "open") {
			void this.reconcileAll();
		} else if (state === "connecting" || state === "reconnecting") {
			this.reconciling = true;
		}
		this.scheduleProjection();
	}

	private handleUserEvent(event: ChannelEnvelope) {
		if (event.type === "session.turn.notify" && event.spaceId) {
			if (this.trackedSpaceIds().includes(event.spaceId)) {
				void this.reconcileOne(event.spaceId);
			}
		}
	}

	private handleSpaceEvent(spaceId: string, event: ChannelEnvelope) {
		if (
			event.type !== "session.turn.created" &&
			event.type !== "session.turn.updated" &&
			event.type !== "session.turn.finalized"
		) {
			return;
		}
		const currentTurns = this.turnsBySpace.get(spaceId) ?? [];
		const turnId = isRecord(event.payload)
			? (event.payload.turn as { id?: unknown } | undefined)?.id
			: null;
		const previous =
			typeof turnId === "string"
				? (currentTurns.find((turn) => turn.id === turnId) ?? null)
				: null;
		const parsed = parseTurnRealtimeEvent(event, previous);
		if (!parsed.accepted) {
			this.reconcileErrors.add(spaceId);
			console.error("[native-activity] Realtime Turn event rejected");
			this.scheduleProjection();
			void this.reconcileOne(spaceId);
			return;
		}
		const applied = applyNativeActivityTurn(currentTurns, parsed.turn);
		if (!applied.accepted) return;
		this.turnsBySpace.set(spaceId, applied.turns);
		const buffered = this.bufferedEventsBySpace.get(spaceId) ?? [];
		buffered.push({ sequence: ++this.eventSequence, turn: parsed.turn });
		this.bufferedEventsBySpace.set(spaceId, buffered.slice(-256));
		this.scheduleProjection();
	}

	private async reconcileOne(spaceId: string) {
		try {
			await this.reconcileSpace(spaceId);
			this.reconcileErrors.delete(spaceId);
		} catch {
			this.reconcileErrors.add(spaceId);
			console.error("[native-activity] Space Turn reconciliation failed");
		} finally {
			this.scheduleProjection();
		}
	}

	private async reconcileAll() {
		return this.reconcileCoordinator.request(async () => {
			if (this.stopped || this.resetting) return;
			this.reconciling = true;
			this.scheduleProjection();
			const spaceIds = this.trackedSpaceIds();
			const results = await Promise.allSettled(
				spaceIds.map((spaceId) => this.reconcileSpace(spaceId)),
			);
			results.forEach((result, index) => {
				const spaceId = spaceIds[index];
				if (!spaceId) return;
				if (result.status === "rejected") this.reconcileErrors.add(spaceId);
				else this.reconcileErrors.delete(spaceId);
			});
			if (results.some((result) => result.status === "rejected")) {
				console.error("[native-activity] Turn reconciliation failed");
			}
			this.reconciling = false;
			this.hasReconciled = true;
			this.snapshotReady = true;
			this.scheduleProjection();
		});
	}

	private async reconcileSpace(spaceId: string) {
		const startSequence = this.eventSequence;
		const items: SpaceTurnListItem[] = [];
		const sessions = new Map<string, SessionRecord>();
		const [turnResponse, sessionResponse] = await Promise.all([
			sdk.space(spaceId).turns.list({ limit: SPACE_TURN_PAGE_LIMIT }),
			sdk.space(spaceId).sessions.list({ limit: SPACE_TURN_PAGE_LIMIT }),
		]);
		if (!Number.isFinite(Date.parse(turnResponse.snapshotAt))) {
			throw new Error("Space turn snapshot timestamp is malformed");
		}
		items.push(...turnResponse.turns);
		for (const session of sessionResponse.sessions)
			sessions.set(session.id, session);

		if (this.explicitFocus?.spaceId === spaceId) {
			const sessionId = this.explicitFocus.sessionId;
			const [detail, latest] = await Promise.all([
				sdk.space(spaceId).session(sessionId).get(),
				sdk.space(spaceId).session(sessionId).turns.listPaginated({ limit: 1 }),
			]);
			sessions.set(detail.session.id, detail.session);
			for (const record of latest.turns) {
				if (items.some((item) => item.id === record.id)) continue;
				items.push({
					...record,
					userPreview: record.userText,
					assistantPreview: record.assistantText,
					session: {
						id: detail.session.id,
						title: detail.session.title,
						source: detail.session.source,
					},
				});
			}
		}

		const sourceOrder = Date.parse(turnResponse.snapshotAt);
		const parsedTurns: NativeActivityTurn[] = [];
		for (const item of items) {
			const parsed = parseNativeActivityTurn({
				spaceId,
				turn: item,
				session: {
					...item.session,
					agentHarness: sessions.get(item.sessionId)?.agentHarness ?? null,
				},
				sourceOrder,
			});
			if (!parsed.accepted) {
				throw new Error(`Space turn snapshot rejected: ${parsed.reason}`);
			}
			parsedTurns.push(parsed.turn);
		}
		let nextTurns = parsedTurns;
		for (const buffered of this.bufferedEventsBySpace.get(spaceId) ?? []) {
			if (buffered.sequence <= startSequence) continue;
			nextTurns = applyNativeActivityTurn(nextTurns, buffered.turn).turns;
		}
		if (
			this.stopped ||
			this.resetting ||
			!this.trackedSpaceIds().includes(spaceId)
		) {
			return;
		}
		this.turnsBySpace.set(spaceId, nextTurns);
		this.bufferedEventsBySpace.set(
			spaceId,
			(this.bufferedEventsBySpace.get(spaceId) ?? []).filter(
				(event) => event.sequence > startSequence,
			),
		);
	}

	private freshness() {
		const trackedSpaces = this.trackedSpaceIds().map((id) =>
			this.spaces.find((space) => space.id === id),
		);
		const relevantOrigins = new Set(
			trackedSpaces.flatMap((space) => (space ? [space.origin] : [])),
		);
		const missingOrigin = trackedSpaces.some((space) => !space);
		const states = [...relevantOrigins].map(
			(origin) => this.connectionStates[origin],
		);
		const connectionState: ConnectionState = states.some(
			(state) => state === "error",
		)
			? "error"
			: states.some((state) => state === "closed")
				? "closed"
				: states.some((state) => state === "reconnecting")
					? "reconnecting"
					: states.some((state) => state === "connecting")
						? "connecting"
						: states.length > 0
							? "open"
							: "idle";
		return resolveNativeFreshness({
			online: this.online,
			connectionState,
			reconciling: this.reconciling,
			hasReconciled: this.hasReconciled,
			reconcileFailed:
				missingOrigin ||
				this.reconcileErrors.size > 0 ||
				this.registrationErrors.size > 0,
		});
	}

	private pulseFocus() {
		const candidateSpaceIds = [...this.watchedSpaceIds];
		if (
			this.currentRouteSpaceId &&
			!candidateSpaceIds.includes(this.currentRouteSpaceId)
		) {
			candidateSpaceIds.push(this.currentRouteSpaceId);
		}
		return selectNativePulseFocus({
			explicitFocus: this.explicitFocus,
			candidateSpaceIds,
			turnsBySpace: this.turnsBySpace,
		});
	}

	private registrationFocus(): NativePulseFocus | null {
		return (
			this.pulseFocus() ??
			(this.watchedSpaceIds[0]
				? {
						spaceId: this.watchedSpaceIds[0],
						sessionId: null,
						explicit: false,
					}
				: null)
		);
	}

	private scheduleProjection() {
		if (this.scheduled || this.stopped) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			this.emitProjection();
		});
	}

	private emitProjection(force = false) {
		if (!this.snapshotReady) return;
		const focus = this.pulseFocus();
		const freshness = this.freshness();
		const draft = buildNativeActivitySnapshot({
			revision: this.revision + 1,
			generatedAt: new Date().toISOString(),
			freshness,
			spaces: this.spaces,
			watchedSpaceIds: this.watchedSpaceIds,
			turnsBySpace: this.turnsBySpace,
			focus,
			currentRouteSpaceId: this.currentRouteSpaceId,
		});
		const identity = snapshotIdentity(draft);
		if (force || identity !== this.lastSnapshotIdentity) {
			this.revision += 1;
			this.storage.setItem(
				this.revisionStorageKey,
				JSON.stringify(this.revision),
			);
			const snapshot = { ...draft, revision: this.revision };
			postNativeMessage(nativeSnapshotReplaceMessage(snapshot));
			this.lastSnapshotIdentity = snapshotIdentity(snapshot);
		}
		void this.updateActivityRegistrations();
		void this.updateRelayPreferences();

		const activeTurn = getFocusedActiveTurn(focus, this.turnsBySpace);
		const nativeActiveTurn =
			activeTurn && draft.primarySessionId === activeTurn.sessionId
				? activeTurn
				: null;
		const nextActivityKey = activityKey(nativeActiveTurn);
		if (nativeActiveTurn && !this.lastActivityKey) {
			postNativeMessage(nativeActivityStartMessage(draft));
		} else if (!nativeActiveTurn && this.lastActivityKey) {
			postNativeMessage(nativeActivityEndMessage());
		}
		this.lastActivityKey = nextActivityKey;
	}

	private handleNativeEvent(detail: unknown) {
		if (this.stateResetAcknowledger.handleEvent(detail)) return;
		if (!isRecord(detail) || detail.schemaVersion !== 1) return;
		const event = detail as NativeEventDetail;
		if (event.type === "bridge.ready") {
			postNativeMessage(nativePushRegisterMessage());
			void this.refreshRelayRegistrations();
			this.emitProjection(true);
			return;
		}
		if (event.type === "pushToStartToken.changed") {
			void this.handleDeviceTokenEvent(event);
			return;
		}
		if (event.type === "activityPushToken.changed") {
			void this.handleActivityTokenEvent(event);
			return;
		}
		if (event.type === "activity.dismissed") {
			void this.handleActivityDismissed(event);
			return;
		}
		if (event.type === "action.failed") {
			this.registrationErrors.add("native-action");
			console.error("[native-activity] Native action failed");
			this.scheduleProjection();
		}
	}

	private async handleDeviceTokenEvent(event: NativeEventDetail) {
		if (event.token !== null) {
			const resolved = resolveNativeTokenEventEnvironment(event.environment);
			if (!resolved.accepted) {
				this.registrationErrors.add("native-environment:device");
				console.error("[native-activity] Device token environment rejected");
				this.scheduleProjection();
				return;
			}
			this.registrationErrors.delete("native-environment:device");
		}
		if (!isNativeRegistrationId(event.installationId)) return;
		if (event.token === null) {
			this.registrationErrors.delete("native-environment:device");
			this.deviceToken = null;
			const deleted = await this.runRegistration("device", () =>
				this.relay.deleteDevice(event.installationId as string),
			);
			if (
				deleted &&
				this.deviceRegistrationIdentity?.installationId === event.installationId
			) {
				this.deviceRegistrationIdentity = null;
				this.persistRegistrationMetadata();
				await this.syncPreferencesAfterIdentityRemoval(event.installationId);
			}
			return;
		}
		if (!isNativePushToken(event.token)) return;
		const environment = resolveNativeTokenEventEnvironment(event.environment);
		if (!environment.accepted) return;
		this.deviceToken = {
			installationId: event.installationId,
			token: event.token,
			environment: environment.environment,
		};
		this.deviceRegistrationIdentity = {
			installationId: event.installationId,
			environment: environment.environment,
		};
		this.persistRegistrationMetadata();
		await this.updateRelayPreferences(true);
		await this.runRegistration("device", () =>
			this.relay.putDevice(this.deviceToken as NativeTokenRegistration),
		);
	}

	private async handleActivityTokenEvent(event: NativeEventDetail) {
		if (event.token !== null) {
			const resolved = resolveNativeTokenEventEnvironment(event.environment);
			if (!resolved.accepted) {
				this.registrationErrors.add("native-environment:activity");
				console.error("[native-activity] Activity token environment rejected");
				this.scheduleProjection();
				return;
			}
			this.registrationErrors.delete("native-environment:activity");
		}
		if (
			!isNativeRegistrationId(event.installationId) ||
			!isNativeRegistrationId(event.activityId)
		) {
			return;
		}
		if (event.token === null) {
			this.registrationErrors.delete("native-environment:activity");
			const deleted = await this.runRegistration(
				`activity:${event.activityId}`,
				() =>
					this.relay.deleteActivity(
						event.installationId as string,
						event.activityId as string,
					),
			);
			if (deleted) {
				this.activityTokens.delete(event.activityId);
				this.activityRegistrationIdentities.delete(event.activityId);
				this.persistRegistrationMetadata();
				await this.syncPreferencesAfterIdentityRemoval(event.installationId);
			}
			return;
		}
		if (!isNativePushToken(event.token)) return;
		const environment = resolveNativeTokenEventEnvironment(event.environment);
		if (!environment.accepted) return;
		this.activityTokens.set(event.activityId, {
			installationId: event.installationId,
			activityId: event.activityId,
			token: event.token,
			environment: environment.environment,
		});
		this.activityRegistrationIdentities.set(event.activityId, {
			installationId: event.installationId,
			activityId: event.activityId,
			environment: environment.environment,
		});
		this.persistRegistrationMetadata();
		await this.updateRelayPreferences(true);
		await this.updateActivityRegistrations(true);
	}

	private async handleActivityDismissed(event: NativeEventDetail) {
		if (!isNativeRegistrationId(event.activityId)) return;
		const stored =
			this.activityTokens.get(event.activityId) ??
			this.activityRegistrationIdentities.get(event.activityId);
		const installationId = isNativeRegistrationId(event.installationId)
			? event.installationId
			: stored?.installationId;
		if (!installationId) return;
		const deleted = await this.runRegistration(
			`activity:${event.activityId}`,
			() =>
				this.relay.deleteActivity(installationId, event.activityId as string),
		);
		if (deleted) {
			this.activityTokens.delete(event.activityId);
			this.activityRegistrationIdentities.delete(event.activityId);
			this.persistRegistrationMetadata();
			await this.syncPreferencesAfterIdentityRemoval(installationId);
		}
	}

	private persistRegistrationMetadata() {
		writeNativeRegistrationMetadata(
			this.storage,
			this.registrationMetadataStorageKey,
			{
				device: this.deviceRegistrationIdentity,
				activities: [...this.activityRegistrationIdentities.values()],
			},
		);
	}

	private async updateActivityRegistrations(force = false) {
		if (this.stopped || this.resetting) return;
		const registrations = [...this.activityTokens.values()];
		const projectionKey = JSON.stringify({
			activityTargets: registrations
				.map((item) => `${item.activityId}:${item.environment}`)
				.sort(),
		});
		await this.registrationCoordinator.request({
			key: projectionKey,
			force,
			register: () =>
				Promise.all(
					registrations.map((registration) =>
						this.relay.putActivity(registration),
					),
				).then(() => undefined),
			onSuccess: () => {
				this.registrationErrors.delete("activity-projection");
				this.scheduleProjection();
			},
			onFailure: () => {
				this.registrationErrors.add("activity-projection");
				console.error("[native-activity] Relay registration failed");
				this.scheduleProjection();
			},
		});
	}

	private preferenceInstallationId() {
		return resolvePreferenceInstallationId(this.deviceRegistrationIdentity, [
			...this.activityRegistrationIdentities.values(),
		]);
	}

	private async updateRelayPreferences(force = false) {
		if (this.stopped || this.resetting) return;
		let installationId: string | null;
		let preferences: NativeActivityPreferences;
		try {
			installationId = this.preferenceInstallationId();
			if (!installationId) return;
			preferences = buildNativeActivityPreferences({
				spaces: this.spaces,
				watchedSpaceIds: this.watchedSpaceIds,
				focus: this.registrationFocus(),
			});
			this.registrationErrors.delete("activity-preferences:shape");
		} catch (error) {
			this.registrationErrors.add("activity-preferences:shape");
			console.error("[native-activity] Relay preferences rejected", error);
			this.scheduleProjection();
			return;
		}
		await this.preferenceCoordinator.request({
			key: preferenceRegistrationKey(installationId, preferences),
			force,
			register: () => this.relay.putPreferences(installationId, preferences),
			onSuccess: () => {
				this.registrationErrors.delete("activity-preferences");
				this.scheduleProjection();
			},
			onFailure: () => {
				this.registrationErrors.add("activity-preferences");
				console.error("[native-activity] Relay preference registration failed");
				this.scheduleProjection();
			},
		});
	}

	private async syncPreferencesAfterIdentityRemoval(
		removedInstallationId: string,
	) {
		let installationId: string | null;
		try {
			installationId = this.preferenceInstallationId();
		} catch (error) {
			this.registrationErrors.add("activity-preferences:shape");
			console.error(
				"[native-activity] Native installation identity rejected",
				error,
			);
			this.scheduleProjection();
			return;
		}
		if (installationId) {
			await this.updateRelayPreferences(true);
			return;
		}
		await this.preferenceCoordinator.request({
			key: `deleted:${removedInstallationId}`,
			force: true,
			register: () => this.relay.deletePreferences(removedInstallationId),
			onSuccess: () => {
				this.registrationErrors.delete("activity-preferences");
				this.scheduleProjection();
			},
			onFailure: () => {
				this.registrationErrors.add("activity-preferences");
				console.error("[native-activity] Relay preference deletion failed");
				this.scheduleProjection();
			},
		});
	}

	private async refreshRelayRegistrations() {
		if (!this.online || this.stopped || this.resetting) return;
		await Promise.all([
			this.updateRelayPreferences(true),
			this.deviceToken
				? this.runRegistration("device", () =>
						this.relay.putDevice(this.deviceToken as NativeTokenRegistration),
					)
				: Promise.resolve(),
			this.updateActivityRegistrations(true),
		]);
	}

	private runRegistration(key: string, action: () => Promise<void>) {
		let operation: Promise<boolean>;
		operation = this.performRegistration(key, action).finally(() => {
			this.pendingRegistrationOperations.delete(operation);
		});
		this.pendingRegistrationOperations.add(operation);
		return operation;
	}

	private async performRegistration(
		key: string,
		action: () => Promise<void>,
	): Promise<boolean> {
		try {
			await runWithBoundedRetry(action, {
				maxAttempts: 3,
				baseDelayMs: 250,
				signal: this.registrationAbortController.signal,
			});
			this.registrationErrors.delete(key);
			return true;
		} catch (error) {
			if (
				this.stopped ||
				this.resetting ||
				(error instanceof DOMException && error.name === "AbortError")
			) {
				return false;
			}
			this.registrationErrors.add(key);
			console.error("[native-activity] Relay registration failed");
			return false;
		} finally {
			this.scheduleProjection();
		}
	}
}

export function startNativeActivityBridge(input: {
	userKey: string;
	storage?: Storage;
}) {
	if (!isNativeActivityHost()) return null;
	const controller = new NativeActivityController(
		input.storage ?? localStorage,
		input.userKey,
	);
	controller.start();
	return controller;
}

export async function resetNativeActivityBridge() {
	if (!registeredController) return;
	await registeredController.resetForAccountExit();
}
