import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BoardNodeRecord,
  BoardTransactionOperation,
  BoardTransactionRecord,
  BoardTransactionsPage,
} from "@cohub/protocol";
import { createBoardConnection } from "@cohub/protocol/board-connection";
import { boardReplayActorKind, createBoardReplayPlayer } from "../src/board/replay.js";

/**
 * The player must be an exact mirror of the server log: rewinding through the
 * stored inverses and replaying the forward payloads has to land on identical
 * documents at every version, including across version gaps left by no-op
 * mutations and across page boundaries.
 */

function nodeRecord(nodeId: string, overrides: Partial<BoardNodeRecord> = {}): BoardNodeRecord {
  return {
    boardId: "board",
    nodeId,
    type: "text",
    parentId: null,
    orderKey: `0000000${nodeId}`,
    x: 0,
    y: 0,
    width: 120,
    height: 40,
    rotation: 0,
    refKind: null,
    refPath: null,
    refUrl: null,
    view: {},
    style: {},
    data: { text: nodeId.toUpperCase() },
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function nodeInput(record: BoardNodeRecord) {
  const { boardId: _b, version: _v, createdAt: _c, updatedAt: _u, ...node } = record;
  return node;
}

function tx(
  version: number,
  operations: BoardTransactionOperation[],
  extra: Partial<BoardTransactionRecord> = {},
): BoardTransactionRecord {
  return {
    id: `tx-${version}`,
    txId: `client-${version}`,
    baseVersion: extra.baseVersion ?? version - 1,
    version,
    actorId: "alice",
    clientId: null,
    undoGroupId: null,
    source: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, version)).toISOString(),
    operations,
    ...extra,
  };
}

const a = nodeRecord("a");
const b = nodeRecord("b");
const movedA = { ...a, x: 300, y: 120 };
const connection = createBoardConnection({ id: "c1", sourceItemId: "a", targetItemId: "b" });

/**
 * History: v1 create a → v2 create b → v3 move a → v4 connect a→b → (v5 no-op,
 * absent) → v6 delete b (cascade drops the connection) → live.
 */
const log: BoardTransactionRecord[] = [
  tx(
    1,
    [
      {
        type: "node.create",
        payload: { node: nodeInput(a) },
        inverse: { type: "node.delete", payload: { nodeId: "a" } },
      },
    ],
    { baseVersion: 0 },
  ),
  tx(2, [
    {
      type: "node.create",
      payload: { node: nodeInput(b) },
      inverse: { type: "node.delete", payload: { nodeId: "b" } },
    },
  ]),
  tx(3, [
    {
      type: "node.patch",
      payload: { nodeId: "a", patch: { x: 300, y: 120 } },
      inverse: { type: "node.patch", payload: { nodeId: "a", patch: { x: 0, y: 0 } } },
    },
  ]),
  tx(4, [
    {
      type: "connection.create",
      payload: { connection },
      inverse: { type: "connection.delete", payload: { connectionId: "c1" } },
    },
  ]),
  tx(
    6,
    [
      {
        type: "node.delete",
        payload: { nodeId: "b" },
        inverse: { type: "node.create", payload: { node: nodeInput(b) } },
      },
      {
        type: "connection.delete",
        payload: { connectionId: "c1" },
        inverse: { type: "connection.create", payload: { connection } },
      },
    ],
    { baseVersion: 4 },
  ),
];

function firstPage(transactions = log, limit = transactions.length): BoardTransactionsPage {
  const newestFirst = [...transactions].sort((x, y) => y.version - x.version);
  const page = newestFirst.slice(0, limit);
  return {
    board: { id: "board", version: 6 },
    transactions: page,
    nextBefore: page.length < newestFirst.length ? (page.at(-1)?.version ?? null) : null,
    snapshot: {
      board: {
        id: "board",
        spaceId: "space",
        title: "Board",
        version: 6,
        metadata: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:06:00.000Z",
      },
      nodes: [movedA],
      connections: [],
    },
  };
}

function ids(player: ReturnType<typeof createBoardReplayPlayer>, version: number) {
  const document = player.documentAt(version);
  return {
    items: document.items.map((item) => `${item.id}@${item.frame.x},${item.frame.y}`),
    connections: document.connections.map((entry) => entry.id),
  };
}

test("a page whose newest transaction is not the board version is rejected", () => {
  const page = firstPage();
  assert.throws(() => createBoardReplayPlayer({ ...page, board: { id: "board", version: 7 } }), /inconsistent/);
});

test("player starts at the live version and exposes the loaded range", () => {
  const player = createBoardReplayPlayer(firstPage());
  assert.equal(player.version, 6);
  assert.equal(player.head, 6);
  assert.equal(player.floor, 0);
  assert.deepEqual(
    player.entries.map((entry) => entry.version),
    [1, 2, 3, 4, 6],
  );
});

test("rewinding through inverses reaches every intermediate state", () => {
  const player = createBoardReplayPlayer(firstPage());
  assert.deepEqual(ids(player, 6), { items: ["a@300,120"], connections: [] });
  assert.deepEqual(ids(player, 4), { items: ["a@300,120", "b@0,0"], connections: ["c1"] });
  assert.deepEqual(ids(player, 3), { items: ["a@300,120", "b@0,0"], connections: [] });
  assert.deepEqual(ids(player, 2), { items: ["a@0,0", "b@0,0"], connections: [] });
  assert.deepEqual(ids(player, 1), { items: ["a@0,0"], connections: [] });
  assert.deepEqual(ids(player, 0), { items: [], connections: [] });
});

test("replaying forward after a rewind is symmetric", () => {
  const player = createBoardReplayPlayer(firstPage());
  const live = ids(player, 6);
  player.seek(0);
  assert.deepEqual(ids(player, 2), { items: ["a@0,0", "b@0,0"], connections: [] });
  assert.deepEqual(ids(player, 6), live);
  // Scrubbing back and forth many times stays stable.
  for (let round = 0; round < 5; round += 1) {
    player.seek(round % 2 === 0 ? 0 : 6);
  }
  assert.deepEqual(ids(player, 4), { items: ["a@300,120", "b@0,0"], connections: ["c1"] });
});

test("seeking into a version gap lands on the nearest loaded version below", () => {
  const player = createBoardReplayPlayer(firstPage());
  assert.equal(player.seek(5), 4);
  assert.deepEqual(ids(player, 5), ids(player, 4));
});

test("seek clamps to the loaded range", () => {
  const player = createBoardReplayPlayer(firstPage());
  assert.equal(player.seek(-10), 0);
  assert.equal(player.seek(99), 6);
});

test("older pages extend the floor without disturbing the position", () => {
  const page = firstPage(log, 2);
  assert.equal(page.nextBefore, 4);
  const player = createBoardReplayPlayer(page);
  assert.equal(player.floor, 3);
  assert.equal(player.seek(0), 3);
  assert.deepEqual(ids(player, 3), { items: ["a@300,120", "b@0,0"], connections: [] });

  const older: BoardTransactionsPage = {
    board: { id: "board", version: 6 },
    transactions: [...log.filter((entry) => entry.version < 4)].sort((x, y) => y.version - x.version),
    nextBefore: null,
  };
  player.prepend(older);
  assert.equal(player.floor, 0);
  assert.equal(player.version, 3);
  assert.deepEqual(ids(player, 0), { items: [], connections: [] });
  assert.deepEqual(ids(player, 6), { items: ["a@300,120"], connections: [] });
  // Prepending the same page again is a no-op.
  player.prepend(older);
  assert.deepEqual(
    player.entries.map((entry) => entry.version),
    [1, 2, 3, 4, 6],
  );
});

test("newer transactions extend the head when the page connects to it", () => {
  const player = createBoardReplayPlayer(firstPage());
  player.seek(2);
  const restoredB = tx(
    7,
    [
      {
        type: "node.create",
        payload: { node: nodeInput(b) },
        inverse: { type: "node.delete", payload: { nodeId: "b" } },
      },
    ],
    { baseVersion: 6 },
  );
  const appended = player.append({
    board: { id: "board", version: 7 },
    transactions: [restoredB, ...log].sort((x, y) => y.version - x.version),
    nextBefore: null,
  });
  assert.equal(appended, true);
  assert.equal(player.head, 7);
  assert.equal(player.version, 2);
  assert.deepEqual(ids(player, 7), { items: ["a@300,120", "b@0,0"], connections: [] });
  assert.deepEqual(ids(player, 6), { items: ["a@300,120"], connections: [] });
});

test("a tail page that skips versions is refused so the caller can page back", () => {
  const player = createBoardReplayPlayer(firstPage());
  // v8 was applied on top of v7, which this page does not include.
  const later = tx(
    8,
    [
      {
        type: "node.patch",
        payload: { nodeId: "a", patch: { x: 1 } },
        inverse: { type: "node.patch", payload: { nodeId: "a", patch: { x: 300 } } },
      },
    ],
    { baseVersion: 7 },
  );
  const refused = player.append({ board: { id: "board", version: 8 }, transactions: [later], nextBefore: 8 });
  assert.equal(refused, false);
  assert.equal(player.head, 6);
  assert.deepEqual(
    player.entries.map((entry) => entry.version),
    [1, 2, 3, 4, 6],
  );
  // Once the connecting page arrives the same tail is accepted.
  const bridge = tx(
    7,
    [
      {
        type: "node.create",
        payload: { node: nodeInput(b) },
        inverse: { type: "node.delete", payload: { nodeId: "b" } },
      },
    ],
    { baseVersion: 6 },
  );
  assert.equal(
    player.append({ board: { id: "board", version: 8 }, transactions: [later, bridge], nextBefore: 7 }),
    true,
  );
  assert.equal(player.head, 8);
  assert.deepEqual(ids(player, 8), { items: ["a@1,120", "b@0,0"], connections: [] });
});

test("order changes are honoured because the player sorts by orderKey", () => {
  const first = nodeRecord("first", { orderKey: "00000001" });
  const second = nodeRecord("second", { orderKey: "00000002" });
  const history = [
    tx(
      1,
      [
        {
          type: "node.create",
          payload: { node: nodeInput(first) },
          inverse: { type: "node.delete", payload: { nodeId: "first" } },
        },
        {
          type: "node.create",
          payload: { node: nodeInput(second) },
          inverse: { type: "node.delete", payload: { nodeId: "second" } },
        },
      ],
      { baseVersion: 0 },
    ),
    tx(2, [
      {
        type: "node.patch",
        payload: { nodeId: "first", patch: { orderKey: "00000003" } },
        inverse: { type: "node.patch", payload: { nodeId: "first", patch: { orderKey: "00000001" } } },
      },
    ]),
  ];
  const page: BoardTransactionsPage = {
    board: { id: "board", version: 2 },
    transactions: [...history].reverse(),
    nextBefore: null,
    snapshot: {
      board: { id: "board", spaceId: "space", title: "Board", version: 2, metadata: {}, createdAt: "", updatedAt: "" },
      nodes: [second, { ...first, orderKey: "00000003" }],
      connections: [],
    },
  };
  const player = createBoardReplayPlayer(page);
  assert.deepEqual(
    player.documentAt(2).items.map((item) => item.id),
    ["second", "first"],
  );
  assert.deepEqual(
    player.documentAt(1).items.map((item) => item.id),
    ["first", "second"],
  );
});

test("board.patch replays appearance through the bare inverse shape", () => {
  const dark = {
    theme: "clean",
    background: { kind: "solid" },
    grid: { visible: true, size: 24, opacity: 0.12 },
    mood: "clean",
  };
  const history = [
    tx(
      1,
      [
        {
          type: "board.patch",
          payload: { patch: { metadataPatch: { appearance: dark } } },
          inverse: { patch: { title: "Board", metadata: {} } },
        },
      ],
      { baseVersion: 0 },
    ),
  ];
  const page: BoardTransactionsPage = {
    board: { id: "board", version: 1 },
    transactions: history,
    nextBefore: null,
    snapshot: {
      board: {
        id: "board",
        spaceId: "space",
        title: "Board",
        version: 1,
        metadata: { appearance: dark },
        createdAt: "",
        updatedAt: "",
      },
      nodes: [],
      connections: [],
    },
  };
  const player = createBoardReplayPlayer(page);
  assert.equal(player.documentAt(1).appearance.grid.visible, true);
  assert.equal(player.documentAt(0).appearance.grid.visible, false);
  assert.equal(player.documentAt(1).appearance.grid.visible, true);
});

test("entries classify actors and collect touched item ids", () => {
  const player = createBoardReplayPlayer(firstPage());
  const last = player.entries.at(-1);
  assert.deepEqual(player.changedItemIds(6), ["b"]);
  assert.equal(last?.kind, "human");
  assert.equal(last?.visual, true);
  assert.equal(boardReplayActorKind({ via: "cli" }), "cli");
  assert.equal(boardReplayActorKind({ via: "tool", toolCallId: "call" }), "agent");
  assert.equal(boardReplayActorKind({ via: "web" }), "human");
});
