import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildSpaceMentionMarkdown,
	buildSpaceMentionUri,
	extractSpaceMentionsFromText,
	formatSpaceMentionTextForDisplay,
	parseCohubSpaceUrls,
	replaceCohubSpaceUrls,
	tokenizeSpaceMentionText,
} from "../lib/mentions/space";

const spaceId = "123e4567-e89b-12d3-a456-426614174000";
const sessionId = "223e4567-e89b-12d3-a456-426614174000";

test("tokenizeSpaceMentionText renders space mentions as semantic tokens", () => {
	const uri = buildSpaceMentionUri(spaceId);
	const tokens = tokenizeSpaceMentionText(`Review @[Core API](${uri}) next.`);

	assert.deepEqual(tokens, [
		{ type: "text", text: "Review " },
		{
			type: "spaceMention",
			label: "Core API",
			spaceId,
			raw: `@[Core API](${uri})`,
			uri,
			href: `/spaces/${spaceId}`,
		},
		{ type: "text", text: " next." },
	]);
});

test("tokenizeSpaceMentionText renders session mentions as semantic tokens", () => {
	const uri = buildSpaceMentionUri(spaceId, sessionId);
	const tokens = tokenizeSpaceMentionText(
		`Review @[Core API/Login flow](${uri}) next.`,
	);

	assert.deepEqual(tokens, [
		{ type: "text", text: "Review " },
		{
			type: "spaceMention",
			label: "Core API/Login flow",
			spaceId,
			sessionId,
			raw: `@[Core API/Login flow](${uri})`,
			uri,
			href: `/spaces/${spaceId}/sessions/${sessionId}`,
		},
		{ type: "text", text: " next." },
	]);
});

test("tokenizeSpaceMentionText ignores mentions embedded in URLs", () => {
	const uri = buildSpaceMentionUri(spaceId);
	const text = `https://sessions.cohub.run/dev/fs-cache@[Core API](${uri})`;

	assert.deepEqual(tokenizeSpaceMentionText(text), [{ type: "text", text }]);
});

test("formatSpaceMentionTextForDisplay renders mention markdown as friendly text", () => {
	const uri = buildSpaceMentionUri(spaceId);

	assert.equal(
		formatSpaceMentionTextForDisplay(`Review @[Core API](${uri}) next.`),
		"Review @Core API next.",
	);
});

test("parseCohubSpaceUrls detects session links", () => {
	assert.deepEqual(
		parseCohubSpaceUrls(`/spaces/${spaceId}/sessions/${sessionId}`),
		[{ raw: `/spaces/${spaceId}/sessions/${sessionId}`, spaceId, sessionId }],
	);
	assert.deepEqual(
		parseCohubSpaceUrls(
			`https://cohub.run/spaces/${spaceId}/sessions/${sessionId}?turn=2`,
		),
		[
			{
				raw: `https://cohub.run/spaces/${spaceId}/sessions/${sessionId}?turn=2`,
				spaceId,
				sessionId,
			},
		],
	);
});

test("replaceCohubSpaceUrls converts session links only when a label is resolved", () => {
	const text = `Open /spaces/${spaceId}/sessions/${sessionId}`;
	assert.equal(
		replaceCohubSpaceUrls(text, (link) =>
			link.sessionId ? "Core API/Login flow" : null,
		),
		`Open ${buildSpaceMentionMarkdown({
			spaceId,
			sessionId,
			label: "Core API/Login flow",
		})}`,
	);
	assert.equal(
		replaceCohubSpaceUrls(text, () => null),
		text,
	);
});

test("replaceCohubSpaceUrls keeps asset URLs with embedded space path intact", () => {
	const text = `https://sessions.cohub.run/dev/fs-cache/spaces/${spaceId}/files/06295bac606fe091/image.png`;

	assert.deepEqual(parseCohubSpaceUrls(text), []);
	assert.equal(
		replaceCohubSpaceUrls(text, () => "Core API"),
		text,
	);
});

test("Space links with additional subpaths stay intact", () => {
	const links = [
		`https://cohub.run/spaces/${spaceId}/files/image.png`,
		`/spaces/${spaceId}/settings`,
		`/spaces/${spaceId}/sessions/${sessionId}/checkpoints/latest`,
		`/spaces/${spaceId}/`,
	];
	const text = links.join(" ");

	assert.deepEqual(parseCohubSpaceUrls(text), []);
	assert.equal(
		replaceCohubSpaceUrls(text, () => "Core API"),
		text,
	);
});

test("extractSpaceMentionsFromText keeps one mention per resource", () => {
	const uri = buildSpaceMentionUri(spaceId);
	const sessionUri = buildSpaceMentionUri(spaceId, sessionId);
	const mentions = extractSpaceMentionsFromText(
		`@[Core API](${uri}) and @[Core API](${uri}) and @[Core API/Login](${sessionUri})`,
	);

	assert.equal(mentions.length, 2);
	assert.equal(mentions[0]?.label, "Core API");
	assert.equal(mentions[0]?.spaceId, spaceId);
	assert.equal(mentions[1]?.label, "Core API/Login");
	assert.equal(mentions[1]?.spaceId, spaceId);
	assert.equal(mentions[1]?.sessionId, sessionId);
});

test("extractSpaceMentionsFromText persists an authoritative origin", () => {
	const uri = buildSpaceMentionUri(spaceId);
	const mentions = extractSpaceMentionsFromText(`@[Core API](${uri})`, {
		resolveOrigin: () => "cloud",
	});

	assert.equal(mentions[0]?.origin, "cloud");
});

test("extractSpaceMentionsFromText leaves legacy unknown origins explicit", () => {
	const uri = buildSpaceMentionUri(spaceId);
	const mentions = extractSpaceMentionsFromText(`@[Core API](${uri})`, {
		resolveOrigin: () => null,
	});

	assert.equal("origin" in (mentions[0] ?? {}), false);
});
