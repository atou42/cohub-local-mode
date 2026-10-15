import type { Command } from "commander";
import type { BoardChapter, BoardVec2 } from "@neta-art/cohub/board";
import { readBoardJsonObject } from "../../board-command-support.js";
import { loadBoardDocument, resolveBundledFonts } from "../../board-export.js";
import {
  boardPathTrack,
  boardSequencePatch,
  buildBoardScene,
  createBoardAnimationSampler,
  createNodeBoardRenderer,
  inspectBoardScene,
  measureBoardText,
} from "../../board-kernel.js";
import { parseBoardTimes } from "../../board-time.js";
import { handleHttp, json as outJson } from "../../output.js";
import { resolveSpace } from "../../space.js";

export function registerBoardAuthoringCommands(boards: Command) {
  boards
    .command("inspect <board>")
    .description("Measure items and report visible layout hints without changing the Board")
    .option("--animation <id>", "Animation to sample")
    .option("--at <times>", "Time, comma-separated times, or start:end:step", "0")
    .option("--items <ids>", "Limit measurements to comma-separated item ids")
    .option("--json", "Output as JSON")
    .action(async (target: string, options: { animation?: string; at: string; items?: string }) => {
      try {
        const { document } = await loadBoardDocument(await resolveSpace(boards), target);
        const times = parseBoardTimes(options.at, "--at", 100);
        const sampler = options.animation ? createBoardAnimationSampler(document, options.animation) : null;
        const renderer = await createNodeBoardRenderer({ fonts: resolveBundledFonts() });
        try {
          const ids = options.items ? new Set(options.items.split(",")) : null;
          outJson({
            samples: times.map((time) => {
              const scene = sampler?.at(time).scene ?? buildBoardScene(document);
              return {
                time,
                diagnostics: inspectBoardScene(scene),
                items: scene.items
                  .filter((item) => !ids || ids.has(item.id))
                  .map((item) => ({
                    id: item.id,
                    bounds: item.frame,
                    ...(item.type === "text" ? { text: measureBoardText(item.props) } : {}),
                  })),
              };
            }),
          });
        } finally {
          renderer.destroy();
        }
      } catch (cause) {
        handleHttp(cause);
      }
    });

  boards
    .command("sequence <board>")
    .description("Compile chapters to an apply-ready animation patch; does not write")
    .requiredOption("-i, --input <file>", "JSON with a chapters array; use - for stdin")
    .requiredOption("--animation <id>", "Parent animation id; recompiling replaces its tracks")
    .action(async (target: string, options: { input: string; animation: string }) => {
      try {
        const input = await readBoardJsonObject(options.input);
        if (
          !Array.isArray(input.chapters) ||
          input.chapters.some(
            (chapter) => !chapter || typeof chapter !== "object" || typeof chapter.animation !== "string",
          )
        )
          throw new Error("Input needs a chapters array with animation IDs.");
        const { document } = await loadBoardDocument(await resolveSpace(boards), target);
        outJson(boardSequencePatch(document, options.animation, input.chapters as BoardChapter[]));
      } catch (cause) {
        handleHttp(cause);
      }
    });

  boards
    .command("path <target>")
    .description("Sample a polyline into a position track; does not write")
    .requiredOption("-i, --input <file>", "JSON with points, duration (ms), optional at, samples and orient")
    .action(async (target: string, options: { input: string }) => {
      try {
        const input = await readBoardJsonObject(options.input);
        if (!Array.isArray(input.points) || input.points.some((point) => !point || typeof point !== "object"))
          throw new Error("Input needs a points array.");
        if (typeof input.duration !== "number") throw new Error("Input needs duration in milliseconds.");
        if (input.orient !== undefined && typeof input.orient !== "boolean") throw new Error("orient must be boolean.");
        outJson(
          boardPathTrack(target, input.points as BoardVec2[], {
            duration: input.duration,
            ...(input.at === undefined ? {} : { at: Number(input.at) }),
            ...(input.samples === undefined ? {} : { samples: Number(input.samples) }),
            orient: input.orient as boolean | undefined,
          }),
        );
      } catch (cause) {
        handleHttp(cause);
      }
    });
}
