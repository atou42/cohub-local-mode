import assert from "node:assert/strict";
import { test } from "node:test";
import {
	filterSpacePickerItems,
	normalizeSpacePickerQuery,
	orderSpacePickerItems,
	selectSpacePickerItems,
} from "../src/space-picker.js";

const spaces = [
	{ id: "a", name: "Alpha", ownerUserUuid: "viewer", isPinned: true },
	{ id: "b", name: "Beta", ownerUserUuid: "other", isPinned: false },
	{ id: "c", name: "Gamma", ownerUserUuid: "viewer", isPinned: false },
];

test("space picker filters mine/pinned and searches names", () => {
	assert.equal(normalizeSpacePickerQuery("  AL pha  "), "al pha");
	assert.deepEqual(
		filterSpacePickerItems(spaces, { filter: "mine", viewerUserUuid: "viewer" }).map(
			(space) => space.id,
		),
		["a", "c"],
	);
	assert.deepEqual(
		filterSpacePickerItems(spaces, { filter: "pinned" }).map((space) => space.id),
		["a"],
	);
	assert.deepEqual(
		filterSpacePickerItems(spaces, { filter: "all", query: "ga" }).map(
			(space) => space.id,
		),
		["c"],
	);
});

test("space picker orders provided recent ids first, then by name", () => {
	assert.deepEqual(
		orderSpacePickerItems(spaces, ["c", "a"]).map((space) => space.id),
		["c", "a", "b"],
	);
	// Without recency, ordering is alphabetical by name.
	assert.deepEqual(
		orderSpacePickerItems(spaces).map((space) => space.id),
		["a", "b", "c"],
	);
});

test("select applies filter, order, and limit", () => {
	assert.deepEqual(
		selectSpacePickerItems(spaces, {
			filter: "all",
			recentSpaceIds: ["c"],
			limit: 2,
		}).map((space) => space.id),
		["c", "a"],
	);
});
