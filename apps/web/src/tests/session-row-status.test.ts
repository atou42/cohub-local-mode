import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionRecord } from "@neta-art/cohub";
import {
	getSessionRowStatus,
	getSessionStoppedLabel,
} from "../lib/session-activity.ts";

type Issue = NonNullable<SessionRecord["lastTurnIssue"]>;

const issue = (status: Issue["status"], reason: string | null): Issue => ({
	turnId: "t",
	sequence: 1,
	status,
	reason,
	errorMessage: null,
});
const kindOf = (lastTurnIssue: Issue, unread = false) =>
	getSessionRowStatus({ lastTurnIssue }, unread, "en").kind;

test("only failures and lost runs are issues", () => {
	assert.equal(kindOf(issue("failed", null)), "failed");
	assert.equal(kindOf(issue("interrupted", "stale_active_recovered")), "lost");
	for (const reason of ["abort", "steer", null]) {
		assert.equal(kindOf(issue("interrupted", reason)), "idle");
	}
	assert.equal(kindOf(issue("interrupted", "abort"), true), "unread");
});

test("explicit user stops have a localized label without becoming issues", () => {
	const session = { lastTurnIssue: issue("interrupted", "abort") };
	assert.equal(getSessionStoppedLabel(session, "en"), "Stopped");
	assert.equal(getSessionStoppedLabel(session, "zh-CN"), "已停止");
	assert.equal(getSessionRowStatus(session, false, "en").kind, "idle");
	assert.equal(getSessionRowStatus(session, true, "en").kind, "unread");
});
