import { AGENT_HARNESSES, type AgentHarness } from "@cohub/protocol/model";
import {
	getFastServiceTier,
	getModelDefaultThinkingLevel,
	getSupportedThinkingLevels,
	type ModelCatalogItem,
	type ModelThinkingLevel,
} from "$lib/model-catalog";

const STORAGE_PREFIX = "cohub:agent-parameter-preferences:v2";
const LEGACY_STORAGE_PREFIX = "cohub:draft-session-model:v1";
const PREFERENCE_VERSION = 2 as const;
const THINKING_LEVELS = new Set<ModelThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
]);

export type AgentModelRef = {
	provider: string;
	id: string;
};

export type AgentModelParameterPreference = {
	thinkingLevel?: ModelThinkingLevel;
	/** `null` explicitly selects Standard. */
	serviceTier?: string | null;
};

export type AgentParameterPreferences = {
	version: typeof PREFERENCE_VERSION;
	lastModelByHarness: Partial<Record<AgentHarness, AgentModelRef>>;
	settingsByModel: Record<string, AgentModelParameterPreference>;
	updatedAt: number;
};

export type AgentParameterPreferencesReadResult =
	| { status: "empty" }
	| {
			status: "ready";
			value: AgentParameterPreferences;
			source: "v2" | "legacy";
	  }
	| { status: "invalid"; message: string };

export class AgentParameterPreferenceStorageError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "AgentParameterPreferenceStorageError";
	}
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function validModelRef(value: unknown): AgentModelRef | null {
	const candidate = record(value);
	if (
		!candidate ||
		typeof candidate.provider !== "string" ||
		!candidate.provider.trim() ||
		typeof candidate.id !== "string" ||
		!candidate.id.trim()
	)
		return null;
	return { provider: candidate.provider.trim(), id: candidate.id.trim() };
}

function modelSettingsKey(harness: AgentHarness, model: AgentModelRef): string {
	return JSON.stringify([harness, model.provider, model.id]);
}

function storageKey(userKey: string) {
	return `${STORAGE_PREFIX}:${encodeURIComponent(userKey)}`;
}

function legacyStorageKey(userKey: string) {
	return [LEGACY_STORAGE_PREFIX, userKey].map(encodeURIComponent).join(":");
}

function browserStorage(): Storage {
	try {
		if (typeof localStorage === "undefined") {
			throw new Error("localStorage is unavailable");
		}
		return localStorage;
	} catch (error) {
		throw new AgentParameterPreferenceStorageError(
			"Saved model settings are unavailable in this browser.",
			{ cause: error },
		);
	}
}

function parsePreferences(raw: string): AgentParameterPreferences {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new AgentParameterPreferenceStorageError(
			"Saved model settings contain invalid JSON.",
			{ cause: error },
		);
	}
	const root = record(parsed);
	if (!root || root.version !== PREFERENCE_VERSION) {
		throw new AgentParameterPreferenceStorageError(
			"Saved model settings use an unsupported format.",
		);
	}
	const lastModelRecord = record(root.lastModelByHarness);
	const settingsRecord = record(root.settingsByModel);
	if (!lastModelRecord || !settingsRecord) {
		throw new AgentParameterPreferenceStorageError(
			"Saved model settings have an invalid structure.",
		);
	}
	const lastModelByHarness: AgentParameterPreferences["lastModelByHarness"] =
		{};
	for (const harness of AGENT_HARNESSES) {
		if (!Object.hasOwn(lastModelRecord, harness)) continue;
		const model = validModelRef(lastModelRecord[harness]);
		if (!model) {
			throw new AgentParameterPreferenceStorageError(
				`Saved ${harness} model is invalid.`,
			);
		}
		lastModelByHarness[harness] = model;
	}
	const settingsByModel: Record<string, AgentModelParameterPreference> = {};
	for (const [key, value] of Object.entries(settingsRecord)) {
		const settings = record(value);
		if (!settings) {
			throw new AgentParameterPreferenceStorageError(
				"Saved model parameters have an invalid structure.",
			);
		}
		const next: AgentModelParameterPreference = {};
		if (Object.hasOwn(settings, "thinkingLevel")) {
			if (
				typeof settings.thinkingLevel !== "string" ||
				!THINKING_LEVELS.has(settings.thinkingLevel as ModelThinkingLevel)
			) {
				throw new AgentParameterPreferenceStorageError(
					"A saved thinking level is invalid.",
				);
			}
			next.thinkingLevel = settings.thinkingLevel as ModelThinkingLevel;
		}
		if (Object.hasOwn(settings, "serviceTier")) {
			if (settings.serviceTier === null) next.serviceTier = null;
			else if (
				typeof settings.serviceTier === "string" &&
				settings.serviceTier.trim()
			) {
				next.serviceTier = settings.serviceTier.trim();
			} else {
				throw new AgentParameterPreferenceStorageError(
					"A saved speed setting is invalid.",
				);
			}
		}
		settingsByModel[key] = next;
	}
	if (typeof root.updatedAt !== "number" || !Number.isFinite(root.updatedAt)) {
		throw new AgentParameterPreferenceStorageError(
			"Saved model settings have an invalid timestamp.",
		);
	}
	return {
		version: PREFERENCE_VERSION,
		lastModelByHarness,
		settingsByModel,
		updatedAt: root.updatedAt,
	};
}

function parseLegacyPreference(raw: string): AgentParameterPreferences {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new AgentParameterPreferenceStorageError(
			"Saved model settings contain invalid legacy JSON.",
			{ cause: error },
		);
	}
	const model = validModelRef(parsed);
	if (!model) {
		throw new AgentParameterPreferenceStorageError(
			"Saved legacy model settings are invalid.",
		);
	}
	const harness: AgentHarness =
		model.provider === "codex"
			? "codex"
			: model.provider === "grok_build"
				? "grok_build"
				: model.provider === "cursor"
					? "cursor"
					: "pi";
	return {
		...createEmptyAgentParameterPreferences(),
		lastModelByHarness: { [harness]: model },
	};
}

export function createEmptyAgentParameterPreferences(): AgentParameterPreferences {
	return {
		version: PREFERENCE_VERSION,
		lastModelByHarness: {},
		settingsByModel: {},
		updatedAt: Date.now(),
	};
}

export function getAgentModelParameterPreference(
	preferences: AgentParameterPreferences,
	harness: AgentHarness,
	model: AgentModelRef,
): AgentModelParameterPreference | null {
	const value = preferences.settingsByModel[modelSettingsKey(harness, model)];
	return value ? { ...value } : null;
}

export function updateAgentParameterPreferences(
	preferences: AgentParameterPreferences,
	input: {
		harness: AgentHarness;
		model: AgentModelRef;
		thinkingLevel?: ModelThinkingLevel;
		serviceTier?: string | null;
	},
): AgentParameterPreferences {
	const key = modelSettingsKey(input.harness, input.model);
	const previous = preferences.settingsByModel[key] ?? {};
	const nextSettings: AgentModelParameterPreference = {
		...previous,
		...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
		...(input.serviceTier !== undefined
			? { serviceTier: input.serviceTier }
			: {}),
	};
	return {
		version: PREFERENCE_VERSION,
		lastModelByHarness: {
			...preferences.lastModelByHarness,
			[input.harness]: { ...input.model },
		},
		settingsByModel: {
			...preferences.settingsByModel,
			[key]: nextSettings,
		},
		updatedAt: Date.now(),
	};
}

export function resolveAgentParameterSelection(input: {
	harness: AgentHarness;
	catalog: ModelCatalogItem[];
	preferences: AgentParameterPreferences;
	preferredModel?: AgentModelRef | null;
}) {
	const visible = input.catalog.filter((item) => item.model.hidden !== true);
	if (visible.length === 0) {
		return {
			model: null,
			thinkingLevel: null,
			serviceTier: undefined,
			notice: null,
			repaired: false,
			preferences: input.preferences,
		};
	}
	const notices: string[] = [];
	let repaired = false;
	let preferences = input.preferences;
	const storedModel =
		input.preferredModel ?? preferences.lastModelByHarness[input.harness];
	const model =
		(storedModel
			? visible.find(
					(item) =>
						item.provider === storedModel.provider &&
						item.id === storedModel.id,
				)
			: null) ?? visible[0];
	if (!model) {
		throw new Error("A visible model catalog unexpectedly had no first model");
	}
	if (
		storedModel &&
		(model.provider !== storedModel.provider || model.id !== storedModel.id)
	) {
		notices.push(
			`${input.preferredModel ? "Selected" : `Saved ${input.harness}`} model is no longer available. Using ${String(model.model.name ?? model.id)}.`,
		);
		preferences = {
			...preferences,
			lastModelByHarness: {
				...preferences.lastModelByHarness,
				[input.harness]: { provider: model.provider, id: model.id },
			},
			updatedAt: Date.now(),
		};
		repaired = true;
	}

	const key = modelSettingsKey(input.harness, model);
	const storedSettings = preferences.settingsByModel[key] ?? {};
	let nextSettings = { ...storedSettings };
	let thinkingLevel = storedSettings.thinkingLevel ?? null;
	if (
		thinkingLevel &&
		!getSupportedThinkingLevels(model).includes(thinkingLevel)
	) {
		thinkingLevel = getModelDefaultThinkingLevel(model);
		nextSettings.thinkingLevel = thinkingLevel;
		notices.push(
			`Saved thinking level for ${String(model.model.name ?? model.id)} is no longer available. Using ${thinkingLevel}.`,
		);
		repaired = true;
	}

	const fastTier = getFastServiceTier(model);
	let serviceTier: string | null | undefined;
	if (fastTier) {
		if (!Object.hasOwn(storedSettings, "serviceTier")) {
			serviceTier = fastTier.id;
		} else if (
			storedSettings.serviceTier === null ||
			storedSettings.serviceTier === fastTier.id
		) {
			serviceTier = storedSettings.serviceTier;
		} else {
			serviceTier = fastTier.id;
			nextSettings.serviceTier = fastTier.id;
			notices.push(
				`Saved speed for ${String(model.model.name ?? model.id)} is no longer available. Using Fast.`,
			);
			repaired = true;
		}
	} else {
		serviceTier = undefined;
		if (Object.hasOwn(storedSettings, "serviceTier")) {
			delete nextSettings.serviceTier;
			notices.push(
				`${String(model.model.name ?? model.id)} no longer supports the saved speed.`,
			);
			repaired = true;
		}
	}

	if (repaired) {
		preferences = {
			...preferences,
			settingsByModel: {
				...preferences.settingsByModel,
				[key]: nextSettings,
			},
			updatedAt: Date.now(),
		};
	}
	return {
		model,
		thinkingLevel,
		serviceTier,
		notice: notices.length > 0 ? notices.join(" ") : null,
		repaired,
		preferences,
	};
}

export function readAgentParameterPreferences(
	userKey: string,
): AgentParameterPreferencesReadResult {
	let storage: Storage;
	try {
		storage = browserStorage();
	} catch (error) {
		return {
			status: "invalid",
			message:
				error instanceof Error
					? error.message
					: "Saved model settings are unavailable.",
		};
	}
	let raw: string | null;
	try {
		raw = storage.getItem(storageKey(userKey));
	} catch {
		return {
			status: "invalid",
			message: "Saved model settings could not be read.",
		};
	}
	if (!raw) {
		let legacyRaw: string | null;
		try {
			legacyRaw = storage.getItem(legacyStorageKey(userKey));
		} catch {
			return {
				status: "invalid",
				message: "Saved legacy model settings could not be read.",
			};
		}
		if (!legacyRaw) return { status: "empty" };
		try {
			return {
				status: "ready",
				value: parseLegacyPreference(legacyRaw),
				source: "legacy",
			};
		} catch (error) {
			return {
				status: "invalid",
				message:
					error instanceof Error
						? error.message
						: "Saved legacy model settings are invalid.",
			};
		}
	}
	try {
		return { status: "ready", value: parsePreferences(raw), source: "v2" };
	} catch (error) {
		return {
			status: "invalid",
			message:
				error instanceof Error
					? error.message
					: "Saved model settings are invalid.",
		};
	}
}

export function writeAgentParameterPreferences(
	preferences: AgentParameterPreferences,
	userKey: string,
) {
	const validated = parsePreferences(JSON.stringify(preferences));
	try {
		browserStorage().setItem(storageKey(userKey), JSON.stringify(validated));
	} catch (error) {
		if (error instanceof AgentParameterPreferenceStorageError) throw error;
		throw new AgentParameterPreferenceStorageError(
			"Saved model settings could not be written.",
			{ cause: error },
		);
	}
}

export function resetAgentParameterPreferences(userKey: string) {
	try {
		const storage = browserStorage();
		storage.removeItem(storageKey(userKey));
		storage.removeItem(legacyStorageKey(userKey));
	} catch (error) {
		if (error instanceof AgentParameterPreferenceStorageError) throw error;
		throw new AgentParameterPreferenceStorageError(
			"Saved model settings could not be reset.",
			{ cause: error },
		);
	}
}
