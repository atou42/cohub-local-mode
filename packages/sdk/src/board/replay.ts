/**
 * Replay the Board transaction log as a sequence of render documents.
 *
 * The player mirrors the server's storage model (node rows, connection rows,
 * board metadata) rather than the render document, because the log is written
 * in those terms: `item.reorder` arrives as a `node.patch` on `orderKey`, and a
 * connection delete arrives with its full pre-delete row as the inverse. Each
 * version is projected to a `BoardDocument` only when asked for, and memoised,
 * so scrubbing a timeline back and forth costs one projection per version.
 *
 * Pure and side-effect free: nothing here talks to a server or writes a Board.
 */
import type {
  BoardConnection,
  BoardNodeInput,
  BoardTransactionOperation,
  BoardTransactionRecord,
  BoardTransactionsPage,
  RequestSource,
} from "@cohub/protocol";
import { boardNodeToAuthoringItem } from "@cohub/protocol";
import type { BoardAppearance, BoardDocument } from "@cohub/protocol/board-document";
import { BOARD_DOCUMENT_KIND, BoardAppearanceSchema, parseBoardDocument } from "@cohub/protocol/board-document";
import { boardAuthoringItemToDocumentItem, DEFAULT_BOARD_APPEARANCE } from "./semantic-document.js";

export type BoardReplayActorKind = "human" | "cli" | "agent";

/** One step on the replay timeline. */
export type BoardReplayEntry = {
  version: number;
  actorId: string;
  kind: BoardReplayActorKind;
  /** Epoch milliseconds. */
  at: number;
  /** Whether the step changed anything visible in the render document. */
  visual: boolean;
};

export type BoardReplayPlayer = ReturnType<typeof createBoardReplayPlayer>;

type ReplayState = {
  nodes: Map<string, BoardNodeInput>;
  connections: Map<string, BoardConnection>;
  metadata: Record<string, unknown>;
};

export function boardReplayActorKind(source: RequestSource | null): BoardReplayActorKind {
  if (!source) return "human";
  if (source.toolCallId) return "agent";
  return source.via === "cli" ? "cli" : "human";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Apply one stored operation (forward payload or inverse) to the mutable state. */
function applyOperation(state: ReplayState, type: string, payload: Record<string, unknown>): void {
  switch (type) {
    case "board.patch": {
      const patch = isRecord(payload.patch) ? payload.patch : {};
      if (isRecord(patch.metadata)) state.metadata = patch.metadata;
      if (isRecord(patch.metadataPatch)) state.metadata = { ...state.metadata, ...patch.metadataPatch };
      return;
    }
    case "node.create": {
      const node = payload.node as BoardNodeInput | undefined;
      if (node) state.nodes.set(node.nodeId, node);
      return;
    }
    case "node.patch": {
      const nodeId = payload.nodeId as string;
      const current = state.nodes.get(nodeId);
      if (current && isRecord(payload.patch)) state.nodes.set(nodeId, { ...current, ...payload.patch, nodeId });
      return;
    }
    case "node.delete":
      state.nodes.delete(payload.nodeId as string);
      return;
    case "connection.create": {
      const connection = payload.connection as BoardConnection | undefined;
      if (connection) state.connections.set(connection.id, connection);
      return;
    }
    case "connection.patch": {
      const connectionId = payload.connectionId as string;
      const current = state.connections.get(connectionId);
      if (current && isRecord(payload.patch)) {
        state.connections.set(connectionId, { ...current, ...payload.patch, id: connectionId } as BoardConnection);
      }
      return;
    }
    case "connection.delete":
      state.connections.delete(payload.connectionId as string);
      return;
    default:
      // effect.* / composition.* live outside the render document.
      return;
  }
}

/**
 * Inverses are stored either as a full operation (`{ type, payload }`) or, for
 * `board.patch`, as a bare `{ patch }`. Normalise both to `(type, payload)`.
 */
function inverseOf(operation: BoardTransactionOperation): { type: string; payload: Record<string, unknown> } | null {
  const inverse = operation.inverse;
  if (!inverse) return null;
  if (typeof inverse.type === "string" && isRecord(inverse.payload)) {
    return { type: inverse.type, payload: inverse.payload };
  }
  if (operation.type === "board.patch" && isRecord(inverse.patch)) {
    return { type: "board.patch", payload: { patch: inverse.patch } };
  }
  return null;
}

function operationItemIds(operation: BoardTransactionOperation): string[] {
  const payload = operation.payload;
  switch (operation.type) {
    case "node.create":
      return isRecord(payload.node) && typeof payload.node.nodeId === "string" ? [payload.node.nodeId] : [];
    case "node.patch":
    case "node.delete":
      return typeof payload.nodeId === "string" ? [payload.nodeId] : [];
    default:
      return [];
  }
}

const VISUAL_OPERATION_TYPES = new Set([
  "board.patch",
  "node.create",
  "node.patch",
  "node.delete",
  "connection.create",
  "connection.patch",
  "connection.delete",
]);

function entryOf(transaction: BoardTransactionRecord): BoardReplayEntry {
  return {
    version: transaction.version,
    actorId: transaction.actorId,
    kind: boardReplayActorKind(transaction.source),
    at: Date.parse(transaction.createdAt),
    visual: transaction.operations.some((operation) => VISUAL_OPERATION_TYPES.has(operation.type)),
  };
}

function appearanceOf(metadata: Record<string, unknown>): BoardAppearance {
  const parsed = BoardAppearanceSchema.safeParse(metadata.appearance);
  return parsed.success ? parsed.data : DEFAULT_BOARD_APPEARANCE;
}

function project(state: ReplayState): BoardDocument {
  const nodes = [...state.nodes.values()].sort((a, b) => (a.orderKey ?? "").localeCompare(b.orderKey ?? ""));
  return parseBoardDocument({
    kind: BOARD_DOCUMENT_KIND,
    version: 1,
    appearance: appearanceOf(state.metadata),
    viewport: { x: 0, y: 0, zoom: 1 },
    items: nodes.map((node) => boardAuthoringItemToDocumentItem(boardNodeToAuthoringItem(node))),
    connections: [...state.connections.values()],
  });
}

function stateFromSnapshot(snapshot: NonNullable<BoardTransactionsPage["snapshot"]>): ReplayState {
  return {
    nodes: new Map(
      snapshot.nodes.map(({ boardId: _boardId, version: _version, createdAt: _c, updatedAt: _u, ...node }) => [
        node.nodeId,
        node,
      ]),
    ),
    connections: new Map(
      snapshot.connections.map(
        ({ boardId: _boardId, revision: _revision, createdAt: _c, updatedAt: _u, ...connection }) => [
          connection.id,
          connection,
        ],
      ),
    ),
    metadata: snapshot.board.metadata,
  };
}

/**
 * Create a player positioned at the live version described by the first page.
 *
 * `transactions` are newest-first as served; the player keeps them oldest-first.
 * Older pages can be added with `prepend`, and newer transactions that arrive
 * live can be added with `append`, so the timeline grows in both directions
 * without a reset.
 */
export function createBoardReplayPlayer(page: BoardTransactionsPage) {
  if (!page.snapshot) throw new Error("Board replay needs the first transactions page (with snapshot).");
  const liveVersion = page.board.version;
  const newest = page.transactions.reduce((max, transaction) => Math.max(max, transaction.version), 0);
  // The server reads the page under one snapshot, so the anchor always has its
  // transaction; a mismatch means a broken page, not a race, and cannot rewind.
  if (page.transactions.length > 0 && newest !== liveVersion) {
    throw new Error(
      `Board replay page is inconsistent: board is at v${liveVersion}, newest transaction is v${newest}.`,
    );
  }
  let transactions: BoardTransactionRecord[] = [...page.transactions].sort((a, b) => a.version - b.version);
  let entries: BoardReplayEntry[] = transactions.map(entryOf);
  // The state is always positioned at `cursor`; documents are memoised per version.
  const state = stateFromSnapshot(page.snapshot);
  let cursor = liveVersion;
  const documents = new Map<number, BoardDocument>();
  /** Oldest version reachable with the transactions loaded so far. */
  let floor = transactions[0]?.baseVersion ?? liveVersion;

  /**
   * Index of the first transaction whose version is `>= version`. Versions are
   * strictly increasing but not dense (a no-op mutation leaves a gap), so
   * binary-search by value rather than indexing by offset.
   */
  function lowerBound(version: number): number {
    let low = 0;
    let high = transactions.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((transactions[mid] as BoardTransactionRecord).version < version) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  function transactionProducing(version: number): BoardTransactionRecord | undefined {
    const candidate = transactions[lowerBound(version)];
    return candidate?.version === version ? candidate : undefined;
  }

  /** Undo the transaction that produced `cursor`. */
  function stepBackward(): boolean {
    const transaction = transactionProducing(cursor);
    if (!transaction) return false;
    for (let index = transaction.operations.length - 1; index >= 0; index -= 1) {
      const inverse = inverseOf(transaction.operations[index] as BoardTransactionOperation);
      if (inverse) applyOperation(state, inverse.type, inverse.payload);
    }
    cursor = transaction.baseVersion;
    return true;
  }

  function stepForward(next: BoardTransactionRecord): void {
    for (const operation of next.operations) applyOperation(state, operation.type, operation.payload);
    cursor = next.version;
  }

  function head(): number {
    return transactions.at(-1)?.version ?? liveVersion;
  }

  /**
   * Move to `version`, clamped to the loaded range. Returns the version reached,
   * which is the nearest loaded version at or below the request.
   */
  function seek(version: number): number {
    const target = Math.max(floor, Math.min(head(), version));
    while (cursor > target && stepBackward()) {
      // Each iteration rewinds exactly one transaction.
    }
    for (
      let next = transactions[lowerBound(cursor + 1)];
      next && next.version <= target;
      next = transactions[lowerBound(cursor + 1)]
    ) {
      stepForward(next);
    }
    return cursor;
  }

  function documentAt(version: number): BoardDocument {
    const reached = seek(version);
    const cached = documents.get(reached);
    if (cached) return cached;
    const document = project(state);
    documents.set(reached, document);
    return document;
  }

  return {
    /** Oldest version the loaded transactions can rewind to. */
    get floor() {
      return floor;
    },
    /** Newest version known to the player. */
    get head() {
      return head();
    },
    get entries(): readonly BoardReplayEntry[] {
      return entries;
    },
    /** Current position. */
    get version() {
      return cursor;
    },
    seek,
    documentAt,
    /** Item ids touched by the transaction that produced `version`, for camera follow. */
    changedItemIds(version: number): string[] {
      return [...new Set(transactionProducing(version)?.operations.flatMap(operationItemIds))];
    },
    /** Add an older page (as served, newest-first). */
    prepend(older: BoardTransactionsPage): void {
      const current = floor;
      const fresh = older.transactions
        .filter((transaction) => transaction.version <= current)
        .sort((a, b) => a.version - b.version);
      if (fresh.length === 0) return;
      transactions = [...fresh, ...transactions];
      entries = [...fresh.map(entryOf), ...entries];
      floor = (fresh[0] as BoardTransactionRecord).baseVersion;
    },
    /**
     * Add transactions that landed after the current head. Forward payloads are
     * enough to extend the timeline; the scrub position is untouched.
     *
     * Returns false when the page does not reach back to the head: the chain
     * would have a hole, so nothing is appended and the caller must fetch an
     * older page (`before` = the page's oldest version) and try again.
     */
    append(latest: BoardTransactionsPage): boolean {
      const current = head();
      const fresh = latest.transactions
        .filter((transaction) => transaction.version > current)
        .sort((a, b) => a.version - b.version);
      if (fresh.length === 0) return true;
      // Contiguous iff the oldest new transaction was applied on top of the
      // head; a higher base means versions in between are missing from this page.
      if ((fresh[0] as BoardTransactionRecord).baseVersion > current) return false;
      transactions = [...transactions, ...fresh];
      entries = [...entries, ...fresh.map(entryOf)];
      return true;
    },
  };
}
