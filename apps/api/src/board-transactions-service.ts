/**
 * Read-only access to the Board transaction log.
 *
 * Replay walks this log in either direction: the first page carries the current
 * rows as a starting point, and every transaction carries the server-computed
 * inverse of each operation, so a client can rewind from the live state to
 * version 0 and play forward again without any extra server work or writes.
 */
import { and, desc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { boardConnections, boardNodes, boardOperations, boardTransactions, boards } from "@cohub/db";
import type {
  BoardTransactionOperation,
  BoardTransactionRecord,
  BoardTransactionsPage,
  BoardTransactionsReadInput,
  RequestSource,
} from "@cohub/protocol";
import { BoardTransactionsReadInputSchema } from "@cohub/protocol";
import { boardConnectionFromRow } from "@cohub/core/board";
import { BoardServiceError } from "./board-ops.js";
import { db } from "./db/index.js";

function requestSource(metadata: Record<string, unknown>): RequestSource | null {
  const source = metadata.source;
  return source && typeof source === "object" && !Array.isArray(source) ? (source as RequestSource) : null;
}

export async function listBoardTransactions(
  spaceId: string,
  boardId: string,
  input: BoardTransactionsReadInput = {},
): Promise<BoardTransactionsPage> {
  // One snapshot for every read: the board row, the live node/connection rows
  // and the transaction rows must describe the same version, or the replay
  // anchor has no transaction to rewind through. Repeatable read gives that
  // without locking anything.
  return db.transaction(
    async (tx) => {
      const { before, limit, snapshot } = BoardTransactionsReadInputSchema.parse(input);
      const [board] = await tx
        .select()
        .from(boards)
        .where(and(eq(boards.id, boardId), eq(boards.spaceId, spaceId)))
        .limit(1);
      if (!board) throw new BoardServiceError(404, "board not found", "BOARD_NOT_FOUND");

      const firstPage = before === undefined;
      const withSnapshot = firstPage && snapshot;
      const [transactionRows, nodes, connections] = await Promise.all([
        tx
          .select({
            id: boardTransactions.id,
            txId: boardTransactions.txId,
            baseVersion: boardTransactions.baseVersion,
            resultVersion: boardTransactions.resultVersion,
            actorId: boardTransactions.actorId,
            clientId: boardTransactions.clientId,
            undoGroupId: boardTransactions.undoGroupId,
            metadata: boardTransactions.metadata,
            createdAt: boardTransactions.createdAt,
          })
          .from(boardTransactions)
          .where(
            and(
              eq(boardTransactions.boardId, boardId),
              // No-op mutations never advanced the version and have nothing to replay.
              isNotNull(boardTransactions.resultVersion),
              ...(firstPage ? [] : [lt(boardTransactions.resultVersion, before)]),
            ),
          )
          .orderBy(desc(boardTransactions.resultVersion))
          // One extra row tells whether an older page exists.
          .limit(limit + 1),
        withSnapshot
          ? tx
              .select()
              .from(boardNodes)
              .where(and(eq(boardNodes.boardId, boardId), isNull(boardNodes.deletedAt)))
              .orderBy(boardNodes.orderKey)
          : Promise.resolve([]),
        withSnapshot
          ? tx
              .select()
              .from(boardConnections)
              .where(and(eq(boardConnections.boardId, boardId), isNull(boardConnections.deletedAt)))
              .orderBy(boardConnections.connectionId)
          : Promise.resolve([]),
      ]);

      const hasMore = transactionRows.length > limit;
      const page = hasMore ? transactionRows.slice(0, limit) : transactionRows;
      const operationRows = page.length
        ? await tx
            .select({
              transactionId: boardOperations.transactionId,
              type: boardOperations.type,
              payload: boardOperations.payload,
              inverse: boardOperations.inverse,
            })
            .from(boardOperations)
            .where(
              inArray(
                boardOperations.transactionId,
                page.map((row) => row.id),
              ),
            )
            .orderBy(boardOperations.transactionId, boardOperations.operationIndex)
        : [];
      const operationsByTransaction = new Map<string, BoardTransactionOperation[]>();
      for (const row of operationRows) {
        const list = operationsByTransaction.get(row.transactionId) ?? [];
        list.push({
          type: row.type as BoardTransactionOperation["type"],
          payload: row.payload,
          inverse: row.inverse ?? null,
        });
        operationsByTransaction.set(row.transactionId, list);
      }

      const transactions: BoardTransactionRecord[] = page.map((row) => ({
        id: row.id,
        txId: row.txId,
        baseVersion: row.baseVersion,
        // Filtered on `is not null` above; the cast only narrows the inferred type.
        version: row.resultVersion as number,
        actorId: row.actorId,
        clientId: row.clientId,
        undoGroupId: row.undoGroupId,
        source: requestSource(row.metadata),
        createdAt: row.createdAt.toISOString(),
        operations: operationsByTransaction.get(row.id) ?? [],
      }));
      const oldest = transactions.at(-1);

      return {
        board: { id: board.id, version: board.version },
        transactions,
        nextBefore: hasMore && oldest ? oldest.version : null,
        ...(withSnapshot
          ? {
              snapshot: {
                board: {
                  id: board.id,
                  spaceId: board.spaceId,
                  title: board.title,
                  version: board.version,
                  metadata: board.metadata,
                  createdAt: board.createdAt.toISOString(),
                  updatedAt: board.updatedAt.toISOString(),
                },
                nodes: nodes.map(({ deletedAt: _deletedAt, ...node }) => ({
                  ...node,
                  createdAt: node.createdAt.toISOString(),
                  updatedAt: node.updatedAt.toISOString(),
                })),
                connections: connections.map(boardConnectionFromRow),
              },
            }
          : {}),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
