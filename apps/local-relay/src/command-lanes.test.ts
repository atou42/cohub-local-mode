import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_READ_COMMANDS,
	getCommandLane,
	selectDispatchableCommands,
} from "./command-lanes.ts";

function command(
	id: string,
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
	status: "queued" | "claimed" | "running" | "succeeded" = "queued",
) {
	return {
		id,
		status,
		request: { method, path: "/api/test", headers: {}, body: "" },
	};
}

test("classifies GET commands into the bounded read lane", () => {
	assert.equal(getCommandLane(command("read")), "read");
	assert.equal(getCommandLane(command("write", "POST")), "mutation");
});

test("keeps a mutation serial while filling up to four read slots", () => {
	const commands = [
		command("write-1", "POST"),
		command("read-1"),
		command("read-2"),
		command("read-3"),
		command("read-4"),
		command("read-5"),
		command("write-2", "PUT"),
	];
	assert.deepEqual(
		selectDispatchableCommands(commands).map((item) => item.id),
		["write-1", "read-1", "read-2", "read-3", "read-4"],
	);
	assert.equal(MAX_READ_COMMANDS, 4);
});

test("does not dispatch a second mutation while one is active", () => {
	const commands = [
		command("active-write", "POST", "running"),
		command("read-1"),
		command("read-2"),
		command("write-2", "PUT"),
	];
	assert.deepEqual(
		selectDispatchableCommands(commands).map((item) => item.id),
		["read-1", "read-2"],
	);
});

test("fills freed mutation and read capacity without counting terminal commands", () => {
	const commands = [
		command("done-read", "GET", "succeeded"),
		command("done-write", "POST", "succeeded"),
		command("next-read"),
		command("next-write", "POST"),
	];
	assert.deepEqual(
		selectDispatchableCommands(commands).map((item) => item.id),
		["next-read", "next-write"],
	);
});
