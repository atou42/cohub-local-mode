import type { BoardTransactionRecord } from "@neta-art/cohub";
import { boardReplayActorKind } from "@neta-art/cohub/board";
import type { Command } from "commander";
import { handleHttp, json, jsonRequested, table } from "../../output.js";
import { finite, type JsonOptions, resolvedBoard, withJson } from "./context.js";

const columns = [
  { key: "version", label: "VERSION" },
  { key: "createdAt", label: "AT" },
  { key: "actor", label: "ACTOR" },
  { key: "via", label: "VIA" },
  { key: "changes", label: "CHANGES" },
];

/** Compact `type×count` summary, e.g. `node.patch×3 connection.create`. */
export function summarizeOperations(operations: BoardTransactionRecord["operations"]): string {
  const counts = new Map<string, number>();
  for (const operation of operations) counts.set(operation.type, (counts.get(operation.type) ?? 0) + 1);
  return [...counts.entries()].map(([type, count]) => (count > 1 ? `${type}×${count}` : type)).join(" ");
}

export function transactionRows(transactions: BoardTransactionRecord[]) {
  return transactions.map((transaction) => ({
    version: transaction.version,
    createdAt: transaction.createdAt,
    actor: transaction.actorId,
    via: boardReplayActorKind(transaction.source),
    changes: summarizeOperations(transaction.operations),
  }));
}

export function registerBoardTransactionCommands(boards: Command): void {
  withJson(
    boards
      .command("transactions <board>")
      .alias("history")
      .description("List the Board transaction log, newest first")
      .option("--before <version>", "Only transactions below this version")
      .option("--limit <count>", "Page size (max 500)", "50")
      .option("--operations", "Include full operations and inverses in --json output")
      .addHelpText(
        "after",
        `
Every applied mutation is one transaction. --json prints the page summary; add
--operations for the full payloads, inverses and (on the newest page) the current
node and connection rows, which is what the web replay view consumes.`,
      ),
  ).action(async (target: string, options: JsonOptions & { before?: string; limit?: string; operations?: boolean }) => {
    try {
      const board = await resolvedBoard(boards, target);
      // The snapshot is only ever printed in full --json --operations output;
      // every other mode would fetch the whole Board just to drop it.
      const full = jsonRequested(options) && Boolean(options.operations);
      const page = await board.transactions({
        ...(options.before !== undefined ? { before: finite(options.before, "--before") } : {}),
        limit: finite(options.limit, "--limit", 50),
        snapshot: full,
      });
      if (jsonRequested(options)) {
        return json(
          full
            ? page
            : {
                ...page,
                transactions: page.transactions.map(({ operations, ...transaction }) => ({
                  ...transaction,
                  operationCount: operations.length,
                })),
              },
        );
      }
      table(transactionRows(page.transactions), columns);
      if (page.nextBefore !== null) {
        console.log(`\nOlder transactions: --before ${page.nextBefore}`);
      }
    } catch (cause) {
      handleHttp(cause);
    }
  });
}
