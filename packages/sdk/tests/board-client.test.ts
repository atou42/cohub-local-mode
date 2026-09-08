import assert from "node:assert/strict";
import { test } from "node:test";
import { BoardClient } from "../src/apis/spaces.js";
import { CohubHttpClient } from "../src/http.js";
import { HttpTransport, type Fetch } from "../src/transport.js";
import type { WebsocketClient, WebsocketEventPayload } from "../src/websocket.js";

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

test("space.board and boards.byId use public authoring and mutation endpoints", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fetch: Fetch = async (input, init) => {
		requests.push({ url: String(input), init });
		return jsonResponse({
			board: { id: "board-1", title: "Plan", version: 1, metadata: {}, updatedAt: null },
			items: [], connections: [], effects: [], compositions: [], playback: null,
		});
	};
	const client = new CohubHttpClient({ baseUrl: "https://api.example.test", fetch });
	const board = client.space("space-1").board("board-1");
	assert.equal(board.id, "board-1");
	assert.equal(client.space("space-1").boards.byId("board-2").id, "board-2");
	await board.authoring({ include: ["items", "connections"], itemIds: ["title"] });
	assert.match(requests[0]?.url ?? "", /\/authoring\?/);
	const authoringUrl = new URL(requests[0]?.url ?? "");
	assert.deepEqual(authoringUrl.searchParams.getAll("include"), ["items", "connections"]);
	assert.equal(authoringUrl.searchParams.get("itemIds"), "title");
	await board.mutateSemantic({ mutationId: "mutation-1", baseVersion: 1, commands: [{ type: "board.patch", patch: { title: "Updated" } }] });
	assert.equal(requests[1]?.url, "https://api.example.test/api/spaces/space-1/boards/board-1/mutations");
});

test("Board authoring defers defaults to the server and rejects empty include", async () => {
	const requests: string[] = [];
	const fetch: Fetch = async (input) => {
		requests.push(String(input));
		return jsonResponse({ board: { id: "board-1", version: 1 }, items: [], connections: [] });
	};
	const client = new CohubHttpClient({ baseUrl: "https://api.example.test", fetch });
	const board = client.space("space-1").board("board-1");
	await board.authoring();
	const url = new URL(requests[0] ?? "");
	assert.deepEqual(url.searchParams.getAll("include"), []);
	assert.throws(() => board.authoring({ include: [] }), /include must not be empty/);
	assert.equal(requests.length, 1);
});

test("Board create rejects invalid semantic items before making a request", async () => {
	let requests = 0;
	const fetch: Fetch = async () => {
		requests += 1;
		return jsonResponse({});
	};
	const client = new CohubHttpClient({ baseUrl: "https://api.example.test", fetch });
	await assert.rejects(
		async () => client.space("space-1").boards.create({
			path: "bad.board",
			items: [{
				id: "bad",
				type: "text",
				frame: { x: 0, y: 0, width: 100, height: 80, rotation: 0 },
				props: { text: "bad", fontSize: 1 },
			}],
		}),
		(error) => error instanceof Error && /fontSize/.test(error.message),
	);
	assert.equal(requests, 0);
});

test("Board realtime subscriptions isolate events by space and Board", () => {
	let eventHandler: ((event: WebsocketEventPayload) => void) | undefined;
	let released = 0;
	let unsubscribed = 0;
	const websocket = {
		state: "open",
		connectionId: "connection-self",
		retainRooms(rooms: string[]) {
			assert.deepEqual(rooms, ["space:space-1", "board:board-1"]);
			return () => {
				released += 1;
			};
		},
		on(type: string, handler: (event: WebsocketEventPayload) => void) {
			assert.equal(type, "event");
			eventHandler = handler;
			return () => {
				unsubscribed += 1;
			};
		},
	} as unknown as WebsocketClient;
	const transport = new HttpTransport({ baseUrl: "https://api.example.test" });
	const board = new BoardClient("space-1", "board-1", transport, websocket);
	const received: string[] = [];
	const stop = board.subscribe({
		changed: () => received.push("changed"),
		awareness: () => received.push("awareness"),
		playback: () => received.push("playback"),
	});

	const emit = eventHandler as (event: WebsocketEventPayload) => void;
	emit({ spaceId: "space-1", type: "board.changed", payload: { boardId: "board-2" } } as WebsocketEventPayload);
	emit({ spaceId: "space-2", type: "board.changed", payload: { boardId: "board-1" } } as WebsocketEventPayload);
	emit({ spaceId: "space-1", type: "board.changed", payload: { boardId: "board-1" } } as WebsocketEventPayload);
	emit({ spaceId: "space-1", type: "board.awareness.updated", payload: { boardId: "board-1", connectionId: "connection-self" } } as WebsocketEventPayload);
	emit({ spaceId: "space-1", type: "board.awareness.updated", payload: { boardId: "board-1", connectionId: "connection-other" } } as WebsocketEventPayload);
	emit({ spaceId: "space-1", type: "board.playback.changed", payload: { boardId: "board-1" } } as WebsocketEventPayload);

	assert.deepEqual(received, ["changed", "awareness", "playback"]);
	stop();
	assert.equal(unsubscribed, 1);
	assert.equal(released, 1);
});

test("Board awareness publishes with the bound Space and Board identity", async () => {
	let published: unknown = null;
	const websocket = {
		async updateBoardAwareness(input: unknown) {
			published = input;
		},
	} as unknown as WebsocketClient;
	const board = new BoardClient(
		"11111111-1111-4111-8111-111111111111",
		"22222222-2222-4222-8222-222222222222",
		new HttpTransport({ baseUrl: "https://api.example.test" }),
		websocket,
	);
	await board.updateAwareness(7, {
		type: "state",
		cursor: { x: 10, y: 20, pointerType: "mouse" },
		tool: "select",
		selection: { ids: [], count: 0, bounds: null },
		editingId: null,
	});
	assert.deepEqual(published, {
		spaceId: "11111111-1111-4111-8111-111111111111",
		boardId: "22222222-2222-4222-8222-222222222222",
		seq: 7,
		update: {
			type: "state",
			cursor: { x: 10, y: 20, pointerType: "mouse" },
			tool: "select",
			selection: { ids: [], count: 0, bounds: null },
			editingId: null,
		},
	});
});
