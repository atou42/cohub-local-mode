import {
	BOARD_ANIMATION_CHANNELS,
	BOARD_BUILTIN_CAPABILITIES,
	BoardCompositionSchema,
	BoardProceduralClipSchema,
	BoardTrackSchema,
	DEFAULT_BOARD_RENDER_LIMITS,
	estimateBuiltinBoardClipCost,
	estimateBuiltinBoardEffectCost,
	validateBuiltinBoardClip,
	validateBuiltinBoardEffect,
	type BoardAnimationTarget,
	type BoardAssetRef,
	type BoardCapability,
	type BoardComposition,
	type BoardDiagnostic,
	type BoardEasing,
	type BoardEffect,
	type BoardProceduralClip,
	type BoardRenderCost,
	type BoardTimelineMarker,
	type BoardTrack,
	type BoardTrackInterpolation,
	type BoardValidationResult,
} from "@cohub/protocol";

export type CompositionInput = Omit<BoardComposition, "revision"> & {
	revision?: number;
};

export type TrackInput = Omit<BoardTrack, "channelVersion" | "metadata"> & {
	channelVersion?: number;
	metadata?: Record<string, unknown>;
};

export type ProceduralClipInput = Omit<
	BoardProceduralClip,
	"kindVersion" | "layer" | "fill" | "easing" | "params" | "assetRefs" | "metadata"
> & {
	kindVersion?: number;
	layer?: BoardProceduralClip["layer"];
	fill?: BoardProceduralClip["fill"];
	easing?: BoardEasing;
	params?: Record<string, unknown>;
	assetRefs?: BoardAssetRef[];
	metadata?: Record<string, unknown>;
};

export function track(input: TrackInput): BoardTrack {
	return BoardTrackSchema.parse(input);
}

export function proceduralClip(input: ProceduralClipInput): BoardProceduralClip {
	return BoardProceduralClipSchema.parse({
		...input,
		kindVersion: input.kindVersion ?? 1,
	});
}

export function composition(input: CompositionInput): BoardComposition {
	return BoardCompositionSchema.parse(input);
}

export function compileComposition(input: {
	id: string;
	name: string;
	duration: number;
	tracks?: TrackInput[];
	clips?: ProceduralClipInput[];
	markers?: BoardTimelineMarker[];
	playback?: BoardComposition["playback"];
	metadata?: Record<string, unknown>;
}): BoardComposition {
	return composition({
		id: input.id,
		name: input.name,
		timeline: {
			duration: input.duration,
			tracks: (input.tracks ?? []).map(track),
			clips: (input.clips ?? []).map(proceduralClip),
			markers: input.markers ?? [],
		},
		playback: input.playback ?? {
			loop: false,
			endBehavior: "hold",
			reducedMotion: { mode: "base" },
		},
		metadata: input.metadata ?? {},
		revision: 0,
	});
}

export type SampledTrack = {
	target: BoardAnimationTarget;
	channel: string;
	value: unknown;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function sampleEasing(easing: BoardEasing, value: number): number {
	const t = clamp01(value);
	switch (easing) {
		case "ease-in-quad":
			return t * t;
		case "ease-out-quad":
			return 1 - (1 - t) ** 2;
		case "ease-in-out-quad":
			return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
		case "ease-in-cubic":
			return t ** 3;
		case "ease-out-cubic":
			return 1 - (1 - t) ** 3;
		case "ease-in-out-cubic":
			return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
		case "ease-out-quart":
			return 1 - (1 - t) ** 4;
		case "ease-out-expo":
			return t === 1 ? 1 : 1 - 2 ** (-10 * t);
		default:
			return t;
	}
}

function interpolate(left: unknown, right: unknown, progress: number): unknown {
	if (typeof left === "number" && typeof right === "number") {
		return left + (right - left) * progress;
	}
	if (
		left &&
		right &&
		typeof left === "object" &&
		typeof right === "object" &&
		!Array.isArray(left) &&
		!Array.isArray(right)
	) {
		const a = left as Record<string, unknown>;
		const b = right as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
			result[key] = interpolate(a[key], b[key], progress);
		}
		return result;
	}
	return progress < 1 ? left : right;
}

/** Deterministically sample one validated Track without touching scene state. */
export function sampleTrack(trackValue: BoardTrack, time: number): SampledTrack | null {
	const frames = trackValue.keyframes;
	const first = frames[0];
	const last = frames.at(-1);
	if (!first || !last) return null;
	if (time < first.time) {
		if (trackValue.fill !== "backwards" && trackValue.fill !== "both") return null;
		return { target: trackValue.target, channel: trackValue.channel, value: first.value };
	}
	if (time > last.time) {
		if (trackValue.fill !== "forwards" && trackValue.fill !== "both") return null;
		return { target: trackValue.target, channel: trackValue.channel, value: last.value };
	}

	let low = 0;
	let high = frames.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((frames[middle]?.time ?? Number.POSITIVE_INFINITY) <= time) low = middle + 1;
		else high = middle;
	}
	const left = frames[Math.max(0, low - 1)] ?? first;
	const right = frames[Math.min(frames.length - 1, low)] ?? last;
	if (left === right || trackValue.interpolation === "step") {
		return { target: trackValue.target, channel: trackValue.channel, value: left.value };
	}
	const span = Math.max(Number.EPSILON, right.time - left.time);
	const progress = sampleEasing(right.easing ?? "linear", (time - left.time) / span);
	return {
		target: trackValue.target,
		channel: trackValue.channel,
		value: interpolate(left.value, right.value, progress),
	};
}

export function sampleCompositionTracks(
	value: BoardComposition,
	time: number,
): SampledTrack[] {
	const position = Math.max(0, Math.min(value.timeline.duration, time));
	return value.timeline.tracks.flatMap((item) => {
		const sampled = sampleTrack(item, position);
		return sampled ? [sampled] : [];
	});
}

export type RenderBounds = { x: number; y: number; width: number; height: number };
export type QualityProfile = "low" | "medium" | "high";

export type BoardExtensionDefinition = BoardCapability & {
	validate?: (params: Record<string, unknown>) => BoardDiagnostic[];
	getBounds?: (params: Record<string, unknown>) => RenderBounds | null;
	getAssetRefs?: (params: Record<string, unknown>) => BoardAssetRef[];
	estimateCost: (
		params: Record<string, unknown>,
		profile: QualityProfile,
	) => Partial<BoardRenderCost>;
};

export type BoardPresetDefinition = BoardCapability & {
	kind: "preset";
	compile: (params: Record<string, unknown>) => BoardComposition;
};

const ZERO_COST: BoardRenderCost = {
	particles: 0,
	vertices: 0,
	dynamicVertices: 0,
	drawCalls: 0,
	filterPasses: 0,
	renderTexturePixels: 0,
	textureBytes: 0,
	bufferBytes: 0,
	simulationSteps: 0,
};

export const DEFAULT_BOARD_LIMITS = DEFAULT_BOARD_RENDER_LIMITS;

function builtinDefinition(capability: BoardCapability): BoardExtensionDefinition {
	return {
		...capability,
		validate() {
			return [];
		},
		estimateCost(params) {
			return estimateBuiltinBoardClipCost({ kind: capability.id, params });
		},
	};
}

export class BoardExtensionRegistry {
	readonly #extensions = new Map<string, BoardExtensionDefinition>();
	readonly #presets = new Map<string, BoardPresetDefinition>();

	constructor() {
		for (const capability of BOARD_BUILTIN_CAPABILITIES) {
			this.register(builtinDefinition(capability));
		}
	}

	register(definition: BoardExtensionDefinition | BoardPresetDefinition): this {
		const key = `${definition.kind}:${definition.id}@${definition.version}`;
		const target = definition.kind === "preset" ? this.#presets : this.#extensions;
		if (target.has(key)) throw new Error(`Board extension is already registered: ${key}`);
		target.set(key, definition as never);
		return this;
	}

	capabilities(): BoardCapability[] {
		return [
			...this.#extensions.values(),
			...this.#presets.values(),
		].map((definition) => ({
			kind: definition.kind,
			id: definition.id,
			version: definition.version,
			...(definition.digest ? { digest: definition.digest } : {}),
			...(definition.renderers ? { renderers: definition.renderers } : {}),
			...(definition.fallbackId ? { fallbackId: definition.fallbackId } : {}),
			...(definition.schema ? { schema: definition.schema } : {}),
		}));
	}

	compilePreset(id: string, version: number, params: Record<string, unknown>) {
		const preset = this.#presets.get(`preset:${id}@${version}`);
		if (!preset) throw new Error(`Unknown Board preset: ${id}@${version}`);
		return preset.compile(params);
	}

	validate(input: {
		composition: BoardComposition;
		effects?: Array<Omit<BoardEffect, "boardId" | "revision">>;
		profile?: QualityProfile;
		limits?: BoardRenderCost;
	}): BoardValidationResult {
		const parsed = BoardCompositionSchema.safeParse(input.composition);
		if (!parsed.success) {
			return {
				valid: false,
				diagnostics: parsed.error.issues.map((issue) => ({
					severity: "error" as const,
					code: "INVALID_COMPOSITION",
					message: issue.message,
					path: issue.path.join("."),
				})),
				peakCost: { ...ZERO_COST },
			};
		}
		const diagnostics: BoardDiagnostic[] = [];
		const composition = parsed.data;
		const cost = { ...ZERO_COST };
		for (const effect of input.effects ?? []) {
			diagnostics.push(
				...validateBuiltinBoardEffect(effect, `effects.${effect.id}`),
			);
			if (!this.#extensions.has(`effect:${effect.kind}@${effect.kindVersion}`)) {
				diagnostics.push({
					severity: "warning",
					code: "UNKNOWN_EFFECT",
					message: `No renderer is registered for ${effect.kind}@${effect.kindVersion}`,
					path: `effects.${effect.id}`,
				});
			}
		}
		const events: Array<{ at: number; direction: 1 | -1; cost: BoardRenderCost }> = [];
		for (const clip of composition.timeline.clips) {
			const definition = this.#extensions.get(`clip:${clip.kind}@${clip.kindVersion}`);
			if (!definition) {
				diagnostics.push({ severity: "warning", code: "UNKNOWN_CLIP", message: `No renderer is registered for ${clip.kind}@${clip.kindVersion}` });
				continue;
			}
			diagnostics.push(...validateBuiltinBoardClip(clip, `composition.timeline.clips.${clip.id}`));
			diagnostics.push(...(definition.validate?.(clip.params) ?? []));
			const estimate = definition.estimateCost(clip.params, input.profile ?? "high");
			const clipCost = { ...ZERO_COST };
			for (const key of Object.keys(clipCost) as Array<keyof BoardRenderCost>) {
				clipCost[key] = estimate[key] ?? 0;
			}
			events.push({ at: clip.start, direction: 1, cost: clipCost });
			events.push({ at: clip.start + clip.duration, direction: -1, cost: clipCost });
		}
		events.sort((left, right) => left.at - right.at || left.direction - right.direction);
		const active = { ...ZERO_COST };
		for (const event of events) {
			for (const key of Object.keys(active) as Array<keyof BoardRenderCost>) {
				active[key] += event.cost[key] * event.direction;
				cost[key] = Math.max(cost[key], active[key]);
			}
		}
		// Effects are resident for the whole board, so their cost adds to the
		// composition peak rather than competing with it.
		for (const effect of input.effects ?? []) {
			const estimate = estimateBuiltinBoardEffectCost(effect);
			for (const key of Object.keys(cost) as Array<keyof BoardRenderCost>) {
				cost[key] += estimate[key] ?? 0;
			}
		}
		const limits = input.limits ?? DEFAULT_BOARD_LIMITS;
		for (const key of Object.keys(cost) as Array<keyof BoardRenderCost>) {
			if (cost[key] > limits[key]) {
				diagnostics.push({
					severity: "warning",
					code: "RENDER_BUDGET_EXCEEDED",
					message: `${key} peaks at ${cost[key]}, above ${limits[key]}`,
					path: key,
					adaptation: { quality: "lower" },
				});
			}
		}
		return {
			valid: !diagnostics.some((item) => item.severity === "error"),
			diagnostics,
			peakCost: cost,
		};
	}
}

export function createBoardExtensionRegistry(): BoardExtensionRegistry {
	return new BoardExtensionRegistry();
}

export const BOARD_CHANNELS = BOARD_ANIMATION_CHANNELS;
export type { BoardTrackInterpolation };
