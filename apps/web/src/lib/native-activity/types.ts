export const NATIVE_ACTIVITY_SCHEMA_VERSION = 1 as const;
export const NATIVE_PUSH_ENVIRONMENTS = ["development", "production"] as const;
export type NativePushEnvironment = (typeof NATIVE_PUSH_ENVIRONMENTS)[number];

export const TURN_STATUSES = [
	"queued",
	"running",
	"abort_requested",
	"completed",
	"failed",
	"interrupted",
	"merged",
	"cancelled",
] as const;

export type NativeTurnStatus = (typeof TURN_STATUSES)[number];
export type NativeActivityPhase =
	| "dispatching"
	| "working"
	| "stopping"
	| "finished"
	| "error";
export type NativeActivityFreshness =
	| "live"
	| "recovering"
	| "stale"
	| "offline";

export type NativeActivityTurn = {
	id: string;
	spaceId: string;
	sessionId: string;
	sessionTitle: string;
	sessionSource: string | null;
	sessionHarness: string | null;
	sequence: number;
	status: NativeTurnStatus;
	provider: string | null;
	model: string | null;
	userPreview: string | null;
	assistantPreview: string | null;
	startedAt: string | null;
	completedAt: string | null;
	createdAt: string;
	updatedAt: string;
	errorMessage: string | null;
	sourceOrder: number;
};

export type NativeActivitySpaceSource = {
	id: string;
	name: string;
	origin: "local" | "cloud";
	isPinned: boolean;
};

export type ExplicitNativeFocus = {
	spaceId: string;
	sessionId: string;
	explicit: true;
};

export type NativePulseFocus = {
	spaceId: string;
	sessionId: string | null;
	explicit: boolean;
};

export type NativeActivityProjection = {
	sessionId: string;
	sessionTitle: string;
	turnId: string;
	status: NativeTurnStatus;
	phase: NativeActivityPhase;
	harness: string | null;
	model: string | null;
	summary: string | null;
	startedAt: string;
	updatedAt: string;
	errorMessage: string | null;
};

export type NativeActivitySpaceSnapshot = {
	spaceId: string;
	spaceName: string;
	origin: "local" | "cloud";
	isPrimary: boolean;
	activeAgentCount: number;
	attentionCount: number;
	activity: NativeActivityProjection | null;
};

export type NativeActivitySnapshot = {
	schemaVersion: typeof NATIVE_ACTIVITY_SCHEMA_VERSION;
	revision: number;
	generatedAt: string;
	freshness: NativeActivityFreshness;
	primarySpaceId: string | null;
	primarySessionId: string | null;
	otherActiveCount: number;
	boardSpaceIds: string[];
	spaces: NativeActivitySpaceSnapshot[];
};

export type NativeActivityContent = {
	spaceId: string;
	spaceName: string;
	origin: "local" | "cloud";
	focus: NativePulseFocus;
	activity: NativeActivityProjection;
	otherActiveCount: number;
	freshness: NativeActivityFreshness;
};

export type NativeFocusViewState = {
	enabled: boolean;
	explicitFocus: ExplicitNativeFocus | null;
};
