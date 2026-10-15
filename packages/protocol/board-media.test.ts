import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyBoardPatchToDocument,
	emptyBoardDocument,
	parseBoardDocument,
	parseBoardMediaSource,
} from "./src/index.js";

const url = "https://cdn.example.com/media?id=123&signature=a%2Fb";

test("all media sources round-trip through patches and stored documents", () => {
	for (const type of ["image", "video", "audio", "file"]) {
		for (const src of [url, "assets/media.png"]) {
			const patch = { items: { media: { type, props: { src } } } };
			const result = applyBoardPatchToDocument(emptyBoardDocument(), patch);
			assert.ok(result.ok, `${type}: ${src}`);
			const parsed = parseBoardDocument(JSON.parse(JSON.stringify(result.document)));
			assert.ok(parsed.ok);
			assert.deepEqual(parsed.document, result.document);
			const props = result.document.items.media?.props;
			assert.ok(props && "src" in props);
			assert.equal(props.src, src);
		}
	}
});

test("invalid URLs never fall through as Space paths, and scripts stay local", () => {
	for (const src of [
		"javascript:alert(1)", "data:image/png;base64,AA==", "blob:https://example.com/id",
		"https://user:secret@example.com/image.png", "http://127.0.0.1/file",
		"http://[::1]/file", "http://169.254.169.254/metadata", "https://localhost/file",
		"https://", "../image.png", "/image.png", "//example.com/image.png", "a\\b.png",
	]) {
		assert.equal(parseBoardMediaSource(src), null, src);
		assert.equal(applyBoardPatchToDocument(emptyBoardDocument(), {
			items: { image: { type: "image", props: { src } } },
		}).ok, false, src);
	}
	assert.equal(applyBoardPatchToDocument(emptyBoardDocument(), {
		items: { custom: { type: "custom", script: { src: "https://cdn.example.com/draw.js" } } },
	}).ok, false);
	assert.equal(applyBoardPatchToDocument(emptyBoardDocument(), {
		items: { custom: { type: "custom", script: { src: "draw.js" } } },
	}).ok, true);
});
