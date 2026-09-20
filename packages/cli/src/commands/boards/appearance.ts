import {
  BoardAppearanceSchema,
  DEFAULT_BOARD_APPEARANCE,
  patchBoardAppearance,
} from "@neta-art/cohub/board";
import type { BoardPlaybackPolicy } from "@neta-art/cohub";
import type { Command } from "commander";
import { handleHttp } from "../../output.js";
import {
  finite,
  type JsonOptions,
  mutateSemantic,
  resolvedBoard,
  showUpdated,
  withJson,
} from "./context.js";

function appearanceFrom(metadata: Record<string, unknown>) {
  const parsed = BoardAppearanceSchema.safeParse(metadata.appearance);
  return parsed.success ? parsed.data : DEFAULT_BOARD_APPEARANCE;
}

export function registerBoardAppearanceCommands(boards: Command): void {
  withJson(boards.command("rename <board> <title>").description("Rename a Board"))
    .action(async (target: string, title: string, options: JsonOptions) => {
      try {
        const board = await resolvedBoard(boards, target);
        showUpdated(await mutateSemantic(board, [{ type: "board.patch", patch: { title } }]), options);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  withJson(boards.command("background <board>")
    .description("Configure the Board background")
    .option("--color <color>", "Solid CSS color")
    .option("--image <url>", "Public image URL")
    .option("--fit <mode>", "cover, contain, or repeat", "cover")
    .option("--position <position>", "center, top, bottom, left, or right", "center")
    .option("--opacity <value>", "Image opacity from 0 to 1", "1")
    .option("--reset", "Restore the default background")
    .addHelpText("after", `
Examples:
  cohub boards background plan.board --color "#123456"
  cohub boards background plan.board --image https://example.com/bg.webp --fit cover --opacity 0.8`))
    .action(async (target: string, options: JsonOptions & {
      color?: string;
      image?: string;
      fit: string;
      position: string;
      opacity: string;
      reset?: boolean;
    }) => {
      try {
        const selected = [options.color, options.image, options.reset ? "reset" : undefined].filter(Boolean);
        if (selected.length !== 1) throw new Error("Choose one of --color, --image, or --reset");
        if (!["cover", "contain", "repeat"].includes(options.fit)) throw new Error("--fit must be cover, contain, or repeat");
        if (!["center", "top", "bottom", "left", "right"].includes(options.position)) throw new Error("--position must be center, top, bottom, left, or right");
        const opacity = finite(options.opacity, "opacity");
        if (opacity < 0 || opacity > 1) throw new Error("opacity must be between 0 and 1");
        const board = await resolvedBoard(boards, target);
        const current = await board.summary();
        const appearance = appearanceFrom(current.board.metadata);
        const background = options.reset
          ? { kind: "solid" as const }
          : options.color
            ? { kind: "solid" as const, color: options.color }
            : {
                kind: "image" as const,
                imageUrl: options.image,
                fit: options.fit as "cover" | "contain" | "repeat",
                position: options.position as "center" | "top" | "bottom" | "left" | "right",
                opacity,
                color: appearance.background.color,
              };
        const result = await mutateSemantic(board, [{
          type: "board.patch",
          patch: { metadataPatch: { appearance: patchBoardAppearance(appearance, { background }) } },
        }], { baseVersion: current.board.version });
        showUpdated(result, options);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  withJson(boards.command("motion <board>")
    .description("Configure the default Board motion for newly added nodes")
    .option("--preset <preset>", "Enter motion preset (deal)")
    .option("--clear", "Disable the default enter motion")
    .addHelpText("after", `
Examples:
  cohub boards motion plan.board --preset deal
  cohub boards motion plan.board --clear`))
    .action(async (target: string, options: JsonOptions & { preset?: string; clear?: boolean }) => {
      try {
        if (Boolean(options.clear) === Boolean(options.preset))
          throw new Error("Use --preset or --clear");
        if (options.preset && options.preset !== "deal")
          throw new Error("--preset must be deal");
        const board = await resolvedBoard(boards, target);
        const current = await board.summary();
        const appearance = appearanceFrom(current.board.metadata);
        const next = patchBoardAppearance(appearance, {
          motion: options.clear
            ? undefined
            : { enter: { kind: "effects.deal", kindVersion: 1, params: {} } },
        });
        showUpdated(await mutateSemantic(board, [{
          type: "board.patch",
          patch: { metadataPatch: { appearance: next } },
        }], { baseVersion: current.board.version }), options);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  withJson(boards.command("playback-policy <board>")
    .description("Configure automatic Board playback")
    .option("--composition <id>", "Composition to play")
    .option("--delay <ms>", "Delay before playback", "0")
    .option("--clear", "Remove the playback policy"))
    .action(async (target: string, options: JsonOptions & {
      composition?: string;
      delay: string;
      clear?: boolean;
    }) => {
      try {
        if (options.clear === Boolean(options.composition)) throw new Error("Use --composition or --clear");
        const delayMs = finite(options.delay, "delay");
        if (delayMs < 0) throw new Error("delay must be non-negative");
        const policy: BoardPlaybackPolicy | null = options.clear
          ? null
          : { compositionId: options.composition as string, delayMs };
        const board = await resolvedBoard(boards, target);
        const current = await board.summary();
        const patch = policy
          ? { metadataPatch: { playback: policy } }
          : { metadata: { ...current.board.metadata, playback: undefined } };
        if (!policy) delete (patch.metadata as Record<string, unknown>).playback;
        showUpdated(await mutateSemantic(board, [{ type: "board.patch", patch }], { baseVersion: current.board.version }), options);
      } catch (cause) {
        handleHttp(cause);
      }
    });
}
