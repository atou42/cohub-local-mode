import assert from "node:assert/strict";
import { test } from "node:test";
import {
	availabilityFromError,
	buildFileSnapshot,
	filePreviewKind,
	filePreviewMemoKey,
	filePreviewScope,
	mergeFileSnapshot,
} from "@neta-art/cohub/board";

/**
 * A missing or unreadable file must not blank its card, and a read that merely
 * failed must not be reported as the file being gone.
 */

test("only a definitive absence is reported as missing", () => {
	const status = (code: number) =>
		availabilityFromError(Object.assign(new Error("x"), { status: code }));

	assert.equal(status(404), "missing");
	assert.equal(status(410), "missing");

	// These say nothing about whether the file exists.
	assert.equal(status(500), "unavailable");
	assert.equal(status(503), "unavailable");
	assert.equal(status(401), "unavailable");
	assert.equal(status(403), "unavailable");
	assert.equal(status(429), "unavailable");
});

test("a network failure with no status is never called missing", () => {
	// Offline: fetch rejects with a plain TypeError and no status.
	assert.equal(
		availabilityFromError(new TypeError("fetch failed")),
		"unavailable",
	);
	assert.equal(availabilityFromError(new Error("timeout")), "unavailable");
	assert.equal(availabilityFromError(undefined), "unavailable");
	assert.equal(availabilityFromError("nope"), "unavailable");
	// A non-numeric status must not be coerced.
	assert.equal(availabilityFromError({ status: "404" }), "unavailable");
});

test("cached facts still render when a fresh read is impossible", () => {
	// The snapshot that was stored when the file was last readable.
	const cached = buildFileSnapshot({
		path: "docs/post.md",
		content: "---\ncover: ./hero.png\n---\nThe body text.",
		mimeType: "text/markdown",
		size: 40,
		mtimeMs: 7,
	});

	// A later failed read produces metadata-only facts; merging must not discard
	// what was already known.
	const afterFailure = {
		...cached,
		...buildFileSnapshot({ path: "docs/post.md" }),
	};
	assert.equal(afterFailure.excerpt, "The body text.");
	assert.equal(afterFailure.coverPath, "docs/hero.png");
	assert.equal(filePreviewKind(afterFailure), "cover");
});

/**
 * Preview caches are keyed by space as well as path.
 *
 * Identical paths across spaces are the norm, and enrichment *commits* the
 * snapshot it reads, so a key collision would not merely show one space's excerpt
 * and cover on another space's card — it would write them into that board.
 */

test("the same path in two spaces never shares a cache entry", () => {
	const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

	assert.notEqual(
		filePreviewScope(a, "README.md"),
		filePreviewScope(b, "README.md"),
	);
	assert.notEqual(
		filePreviewMemoKey(a, "README.md", 0),
		filePreviewMemoKey(b, "README.md", 0),
	);
	// The unenriched case is the dangerous one: with no mtime yet, every card in
	// every space would otherwise collapse onto one key.
	assert.notEqual(
		filePreviewMemoKey(a, "README.md", undefined),
		filePreviewMemoKey(b, "README.md", undefined),
	);
	// Same space and file: sharing is the point.
	assert.equal(
		filePreviewMemoKey(a, "README.md", 17),
		filePreviewMemoKey(a, "README.md", 17),
	);
});

test("no path can be crafted to collide with another space's entry", () => {
	const space = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
	// A path containing the separator, or another space id, must stay in its own
	// namespace rather than forging a key in someone else's.
	for (const path of [
		`${other}/README.md`,
		"a\u0000b",
		`..\u0000${other}\u0000x`,
	]) {
		assert.notEqual(
			filePreviewScope(space, path),
			filePreviewScope(other, "README.md"),
		);
		assert.ok(filePreviewScope(space, path).startsWith(`${space}\u0000`));
	}
});

test("a changed file misses the cache", () => {
	const space = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	assert.notEqual(
		filePreviewMemoKey(space, "docs/post.md", 1000),
		filePreviewMemoKey(space, "docs/post.md", 2000),
	);
});

/**
 * A file card's snapshot must be able to lose facts, not just gain them.
 *
 * Enrichment commits the result, so a fact that cannot be cleared is a fact that
 * gets rewritten to the board forever.
 */

test("a complete read clears facts the file no longer has", () => {
	// The Markdown file previously had a frontmatter cover and a body.
	const cached = buildFileSnapshot({
		path: "docs/post.md",
		content: "---\ncover: ./hero.png\n---\nThe body text.",
		mimeType: "text/markdown",
		size: 40,
		mtimeMs: 1000,
	});
	assert.ok(cached.coverPath);
	assert.ok(cached.excerpt);

	// The cover line and the body are gone. A snapshot omits what is absent, so the
	// incoming facts simply have no cover or excerpt.
	const fresh = buildFileSnapshot({
		path: "docs/post.md",
		content: "",
		mimeType: "text/markdown",
		size: 0,
		mtimeMs: 2000,
	});
	assert.equal(fresh.coverPath, undefined);
	assert.equal(fresh.excerpt, undefined);

	const merged = mergeFileSnapshot(cached, fresh, true);
	assert.equal(merged.coverPath, undefined, "a removed cover must disappear");
	assert.equal(merged.excerpt, undefined, "a removed excerpt must disappear");
	assert.equal(merged.mtimeMs, 2000);
});

test("an incomplete read keeps the cached facts", () => {
	const cached = buildFileSnapshot({
		path: "docs/post.md",
		content: "---\ncover: ./hero.png\n---\nThe body text.",
		mimeType: "text/markdown",
		size: 40,
		mtimeMs: 1000,
	});
	// A failed read yields metadata only. Replacing with it would blank a card that
	// is merely unreachable right now.
	const partial = buildFileSnapshot({
		path: "docs/post.md",
		mimeType: "text/markdown",
	});
	const merged = mergeFileSnapshot(cached, partial, false);
	assert.equal(merged.coverPath, cached.coverPath);
	assert.equal(merged.excerpt, cached.excerpt);
	assert.equal(merged.mtimeMs, 1000);
});

test("a card with no facts at all is still a usable blank card", () => {
	const snapshot = buildFileSnapshot({ path: "data/unknown.bin" });
	assert.equal(snapshot.title, "unknown");
	assert.equal(filePreviewKind(snapshot), "blank");
});
