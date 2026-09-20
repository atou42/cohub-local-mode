/**
 * One-shot entrance motion primitives.
 *
 * The runtime owns the lifecycle; this module only resolves preset parameters
 * and evaluates a pose. `effects.deal` is the first built-in preset, not a
 * special Board-wide animation mode.
 */

import {
	type AnimationPose,
	clamp01,
	createPose,
	hashUnit,
} from "./animation-core";

export const ENTRANCE_DURATION_MS = 520;
export const ENTRANCE_LANDING_MS = 600;
export const ENTRANCE_REDUCED_MS = 180;
export const ENTRANCE_TOTAL_MS = ENTRANCE_DURATION_MS + ENTRANCE_LANDING_MS;

export type EntranceMotionParams = {
	lift?: number;
	swing?: number;
	curve?: number;
	tilt?: number;
	scale?: number;
	duration?: number;
	landing?: number;
};

type ResolvedEntranceMotionParams = {
	lift: number;
	swing: number;
	curve: number;
	tilt: number;
	scale: number;
	duration: number;
	landing: number;
};

const DEFAULT_PARAMS: ResolvedEntranceMotionParams = {
	lift: 90,
	swing: 48,
	curve: 18,
	tilt: 8,
	scale: 0.86,
	duration: ENTRANCE_DURATION_MS,
	landing: ENTRANCE_LANDING_MS,
};

/** Mirrors `BoardDealParamsSchema`; the runtime never trusts a document blindly. */
const MAX_PARAMS: ResolvedEntranceMotionParams = {
	lift: 2_000,
	swing: 2_000,
	curve: 2_000,
	tilt: 180,
	scale: 2,
	duration: 10_000,
	landing: 10_000,
};

function finite(
	value: unknown,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(maximum, Math.max(minimum, value))
		: fallback;
}

export function resolveEntranceParams(
	params: Record<string, unknown> = {},
): ResolvedEntranceMotionParams {
	const clamp = (key: keyof ResolvedEntranceMotionParams, minimum: number) =>
		finite(params[key], DEFAULT_PARAMS[key], minimum, MAX_PARAMS[key]);
	return {
		lift: clamp("lift", 0),
		swing: clamp("swing", 0),
		curve: clamp("curve", 0),
		tilt: clamp("tilt", 0),
		scale: clamp("scale", 0.05),
		duration: clamp("duration", 1),
		landing: clamp("landing", 0),
	};
}

/** Reduced motion is a plain fade: no landing highlight, no extra tail. */
export function entranceTotalMs(
	reducedMotion: boolean,
	params: EntranceMotionParams = {},
): number {
	if (reducedMotion) return ENTRANCE_REDUCED_MS;
	const resolved = resolveEntranceParams(params);
	return resolved.duration + resolved.landing;
}

function easeOutCubic(t: number): number {
	return 1 - (1 - t) ** 3;
}

function easeOutBack(t: number): number {
	const c1 = 1.70158;
	const c3 = c1 + 1;
	return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

export function entranceProgress(
	elapsedMs: number,
	reducedMotion: boolean,
	params: EntranceMotionParams = {},
): number {
	const duration = reducedMotion
		? ENTRANCE_REDUCED_MS
		: resolveEntranceParams(params).duration;
	return clamp01(elapsedMs / duration);
}

export function landingProgress(
	elapsedMs: number,
	reducedMotion = false,
	params: EntranceMotionParams = {},
): number {
	if (reducedMotion) return 0;
	const resolved = resolveEntranceParams(params);
	if (elapsedMs < resolved.duration || resolved.landing <= 0) return 0;
	return 1 - clamp01((elapsedMs - resolved.duration) / resolved.landing);
}

export function entrancePose(
	id: string,
	t: number,
	reducedMotion = false,
	params: EntranceMotionParams = {},
): AnimationPose {
	const pose = createPose();
	if (reducedMotion) {
		pose.alpha = easeOutCubic(t);
		return pose;
	}
	const resolved = resolveEntranceParams(params);
	const remaining = Math.max(0, 1 - t);
	const enter = easeOutBack(t);
	const swingSign = hashUnit(`${id}:dir`) > 0.5 ? 1 : -1;
	const swing = 0.35 + hashUnit(`${id}:x`) * 0.65;
	const curve = 0.45 + hashUnit(`${id}:curve`) * 0.55;
	const tilt = 0.4 + hashUnit(`${id}:tilt`) * 0.6;
	pose.x = swingSign * resolved.swing * swing * remaining ** 0.9;
	pose.y =
		-(remaining * resolved.lift) -
		resolved.curve * curve * Math.sin(t * Math.PI) * remaining;
	pose.rotation =
		((swingSign * (resolved.tilt * Math.PI)) / 180) * tilt * remaining ** 0.85;
	const scale = resolved.scale + (1 - resolved.scale) * enter;
	pose.scaleX = scale;
	pose.scaleY = scale;
	pose.alpha = easeOutCubic(Math.min(1, t / 0.3));
	// Avoid -0 from sign * 0, which fails strict equality in tests and JSON.
	if (pose.x === 0) pose.x = 0;
	if (pose.y === 0) pose.y = 0;
	if (pose.rotation === 0) pose.rotation = 0;
	return pose;
}

export function entranceLandingAlpha(
	elapsedMs: number,
	reducedMotion = false,
	params: EntranceMotionParams = {},
): number {
	return landingProgress(elapsedMs, reducedMotion, params) * 0.85;
}
