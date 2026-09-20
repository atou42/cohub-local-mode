import { z } from "zod";

/**
 * Board effect schema, isolated so `board-authoring.ts` can reuse the exact
 * definition without a runtime cycle through `board.ts`. One definition, one
 * strictness level — semantic mutations and Board create must not drift apart.
 */

const idSchema = z.string().min(1).max(160);
const extensionIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/).max(160);
const jsonObjectSchema = z.record(z.string(), z.unknown());

export const BoardAssetRefSchema = z.object({
  type: z.enum(["space-file", "extension"]),
  ref: z.string().min(1).max(4096),
  digest: z.string().min(16).max(160).optional(),
}).strict();

export const BoardEffectSchema = z.object({
  id: idSchema,
  boardId: z.string().uuid(),
  target: z.discriminatedUnion("type", [
    z.object({ type: z.literal("item"), itemId: idSchema }).strict(),
    z.object({ type: z.literal("board") }).strict(),
  ]),
  kind: extensionIdSchema,
  kindVersion: z.number().int().positive().default(1),
  enabled: z.boolean().default(true),
  lifecycle: z.enum(["persistent", "when-visible", "manual", "on-enter"]),
  timeOrigin: z.enum(["board", "visible", "activation"]),
  layer: z.enum(["behind", "front", "screen"]).default("front"),
  seed: z.string().min(1).max(160),
  params: jsonObjectSchema.default({}),
  assetRefs: z.array(BoardAssetRefSchema).default([]),
  metadata: jsonObjectSchema.default({}),
  revision: z.number().int().nonnegative(),
}).strict();

export type BoardAssetRef = z.infer<typeof BoardAssetRefSchema>;
export type BoardEffect = z.infer<typeof BoardEffectSchema>;

/** The client-authored effect form: no server-owned `boardId`/`revision`. */
export const BoardEffectInputSchema = BoardEffectSchema.omit({
  boardId: true,
  revision: true,
});
export type BoardEffectInput = z.infer<typeof BoardEffectInputSchema>;

/** Accept a read projection in a write command while stripping server fields. */
export function parseBoardEffectInput(value: unknown): BoardEffectInput {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const { boardId: _boardId, revision: _revision, ...input } = value as Record<string, unknown>;
    return BoardEffectInputSchema.parse(input);
  }
  return BoardEffectInputSchema.parse(value);
}

export type BoardAuthoringEffect = BoardEffectInput & { revision?: number };
