import assert from "node:assert/strict";
import test from "node:test";
import {
	localNodeErrorMessage,
	localRelayCommandFailure,
} from "$lib/local-node-error";

test("replaces a local Cloudflare gateway page with an offline message", () => {
	const error = new Error(
		"<!DOCTYPE html><html><head><title>cohub.atou.cc | 502: Bad gateway</title></head></html>",
	);
	assert.equal(
		localNodeErrorMessage(error, "Failed", true),
		"Local Mac is offline",
	);
});

test("does not hide unrelated or cloud Space errors", () => {
	assert.equal(
		localNodeErrorMessage(new Error("Permission denied"), "Failed", true),
		"Permission denied",
	);
	assert.match(
		localNodeErrorMessage(new Error("502: Bad gateway"), "Failed", false),
		/Bad gateway/,
	);
});

test("surfaces the Local API reason carried by a failed relay command", () => {
	assert.deepEqual(
		localRelayCommandFailure({
			errorCode: "local_api_rejected",
			errorMessage: "Local API returned HTTP 422",
			result: {
				status: 422,
				body: JSON.stringify({
					code: "effort_unavailable",
					message: "Requested effort is not available for the chosen model",
				}),
			},
		}),
		{
			code: "effort_unavailable",
			message: "Requested effort is not available for the chosen model",
		},
	);
	assert.deepEqual(
		localRelayCommandFailure({
			errorCode: "local_api_rejected",
			errorMessage: "Local API returned HTTP 500",
			result: { status: 500, body: "not json" },
		}),
		{
			code: "local_api_rejected",
			message: "Local API returned HTTP 500",
		},
	);
});
