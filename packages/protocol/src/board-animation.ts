import { z } from "zod";

const extensionKindSchema = z
	.string()
	.regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/)
	.max(160);
const jsonObjectSchema = z.record(z.string(), z.unknown());
const finiteSchema = z.number().finite();

/** Parameters shared by the built-in deal entrance preset. */
export const BoardDealParamsSchema = z
	.object({
		lift: finiteSchema.nonnegative().max(2_000).optional(),
		swing: finiteSchema.nonnegative().max(2_000).optional(),
		curve: finiteSchema.nonnegative().max(2_000).optional(),
		tilt: finiteSchema.nonnegative().max(180).optional(),
		scale: finiteSchema.positive().max(2).optional(),
		duration: finiteSchema.positive().max(10_000).optional(),
		landing: finiteSchema.nonnegative().max(10_000).optional(),
	})
	.strict();
export type BoardDealParams = z.infer<typeof BoardDealParamsSchema>;

/** A versioned, reusable animation preset reference. */
export const BoardAnimationSpecSchema = z
	.object({
		kind: extensionKindSchema,
		kindVersion: z.number().int().positive().default(1),
		params: jsonObjectSchema.default({}),
	})
	.strict()
	.superRefine((spec, context) => {
		// Params are validated per kind@version; v2 of any preset brings its own schema.
		if (spec.kind !== "effects.deal" || spec.kindVersion !== 1) return;
		const parsed = BoardDealParamsSchema.safeParse(spec.params);
		if (parsed.success) return;
		context.addIssue({
			code: "custom",
			message: parsed.error.issues[0]?.message ?? "invalid effects.deal parameters",
			path: ["params", ...(parsed.error.issues[0]?.path ?? [])],
		});
	});
export type BoardAnimationSpec = z.infer<typeof BoardAnimationSpecSchema>;

/** Board-wide default motion policies. Omitted policies mean no motion. */
export const BoardMotionSchema = z
	.object({
		enter: BoardAnimationSpecSchema.optional(),
	})
	.strict();
export type BoardMotion = z.infer<typeof BoardMotionSchema>;
