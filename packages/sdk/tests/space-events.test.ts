import assert from "node:assert/strict";
import test from "node:test";
import { SpaceClient, SpaceEventsApi } from "../src/apis/spaces.js";
import type {
	WebsocketClient,
	WebsocketEventPayload,
} from "../src/websocket.js";

test("SpaceEventsApi routes published Work versions for the selected Space", () => {
	let emit: ((event: WebsocketEventPayload) => void) | null = null;
	let released = 0;
	const websocket = {
		state: "open",
		retainRooms(rooms: string[]) {
			assert.deepEqual(rooms, ["space:space-1"]);
			return () => {
				released += 1;
			};
		},
		on(type: string, handler: (event: WebsocketEventPayload) => void) {
			assert.equal(type, "event");
			emit = handler;
			return () => undefined;
		},
	} as unknown as WebsocketClient;
	const events = new SpaceEventsApi(websocket, "space-1");
	const received: string[] = [];
	const stop = events.on("app.version.published", (event) => {
		received.push(event.type);
	});
	const publish = emit as unknown as (event: WebsocketEventPayload) => void;
	publish({
		spaceId: "space-2",
		type: "app.version.published",
		payload: {},
	} as WebsocketEventPayload);
	publish({
		spaceId: "space-1",
		type: "task.updated",
		payload: {},
	} as WebsocketEventPayload);
	publish({
		spaceId: "space-1",
		type: "app.version.published",
		payload: {},
	} as WebsocketEventPayload);

	assert.deepEqual(received, ["app.version.published"]);
	stop();
	assert.equal(released, 1);
});

test("a rejected room subscription reaches the subscriber", () => {
	let emit: ((event: WebsocketEventPayload) => void) | null = null;
	const websocket = {
		state: "open",
		retainRooms: () => () => undefined,
		on(type: string, handler: (event: WebsocketEventPayload) => void) {
			assert.equal(type, "event");
			const previous = emit;
			emit = (event) => {
				previous?.(event);
				handler(event);
			};
			return () => undefined;
		},
	} as unknown as WebsocketClient;

	const spaceEvents: string[] = [];
	new SpaceEventsApi(websocket, "space-1").subscribe((event) => {
		spaceEvents.push(event.type);
	});
	const sessionErrors: string[] = [];
	new SpaceClient("space-1", {} as never, websocket)
		.session("session-1")
		.subscribe({ error: (event) => sessionErrors.push(event.type) });

	const publish = emit as unknown as (event: WebsocketEventPayload) => void;
	publish({
		type: "system.subscribe.error",
		payload: { rejected: [{ room: "space:space-2", code: "FORBIDDEN", message: "" }] },
	} as WebsocketEventPayload);
	publish({
		type: "system.subscribe.error",
		payload: { rejected: [{ room: "space:space-1", code: "FORBIDDEN", message: "" }] },
	} as WebsocketEventPayload);

	assert.deepEqual(spaceEvents, ["system.subscribe.error"]);
	assert.deepEqual(sessionErrors, ["system.subscribe.error"]);
});
