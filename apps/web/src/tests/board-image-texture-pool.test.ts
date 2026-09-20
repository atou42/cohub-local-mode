import assert from "node:assert/strict";
import { test } from "node:test";
import type { Texture } from "pixi.js";
import { createBoardAssetManager } from "../lib/board/board-asset-manager.ts";
import { createBoardImageTexturePool } from "../lib/board/board-image-texture-pool.ts";

type FakeTexture = Texture & {
	destroyed: boolean;
};

function fakeTexture(): FakeTexture {
	return { width: 10, height: 10, destroyed: false } as FakeTexture;
}

function imageItem(path: string) {
	return {
		id: path,
		type: "image" as const,
		ref: { kind: "space-file" as const, path },
		snapshot: { mimeType: "image/png" },
		frame: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the image pool shares an in-flight load and unloads after the last release", async () => {
	let loadCount = 0;
	let unloadCount = 0;
	const texture = fakeTexture();
	const pool = createBoardImageTexturePool({
		loadTexture: async () => {
			loadCount += 1;
			return texture;
		},
		unloadTexture: async (_url, value) => {
			unloadCount += 1;
			assert.equal(value, texture);
			texture.destroyed = true;
		},
	});

	const first = pool.acquire("https://cdn.example/image.png");
	const second = pool.acquire("https://cdn.example/image.png");
	const [firstTexture, secondTexture] = await Promise.all([first, second]);

	assert.equal(loadCount, 1);
	assert.equal(firstTexture, texture);
	assert.equal(secondTexture, texture);

	await pool.release("https://cdn.example/image.png");
	assert.equal(unloadCount, 0);
	assert.equal(texture.destroyed, false);

	await pool.release("https://cdn.example/image.png");
	assert.equal(unloadCount, 1);
	assert.equal(texture.destroyed, true);
});

test("a request during unload waits and receives a fresh texture", async () => {
	let loadCount = 0;
	let unloadCount = 0;
	let resolveUnload = () => {};
	const firstTexture = fakeTexture();
	const secondTexture = fakeTexture();
	const pool = createBoardImageTexturePool({
		loadTexture: async () => {
			loadCount += 1;
			return loadCount === 1 ? firstTexture : secondTexture;
		},
		unloadTexture: async () => {
			unloadCount += 1;
			if (unloadCount > 1) return;
			await new Promise<void>((resolve) => {
				resolveUnload = resolve;
			});
		},
	});

	assert.equal(await pool.acquire("shared"), firstTexture);
	const release = pool.release("shared");
	const reload = pool.acquire("shared");
	await flush();
	assert.equal(loadCount, 1);

	resolveUnload();
	await release;
	assert.equal(await reload, secondTexture);
	assert.equal(loadCount, 2);
	await pool.release("shared");
	assert.equal(unloadCount, 2);
});

test("separate Board managers do not unload an image still used by another manager", async () => {
	let loadCount = 0;
	let unloadCount = 0;
	const texture = fakeTexture();
	const pool = createBoardImageTexturePool({
		loadTexture: async () => {
			loadCount += 1;
			return texture;
		},
		unloadTexture: async () => {
			unloadCount += 1;
		},
	});
	const options = {
		spaceId: "space",
		lruBudget: { maxCount: 0, maxBytes: 0 },
		imageTexturePool: pool,
		resolveSpaceFileUrl: async (_spaceId: string, path: string) => path,
	};
	const first = createBoardAssetManager(options);
	const second = createBoardAssetManager(options);
	const item = imageItem("shared.png");
	const firstKey = first.assetKey(item);
	const secondKey = second.assetKey(item);
	assert.ok(firstKey);
	assert.equal(secondKey, firstKey);

	first.acquire(firstKey);
	first.requestItem(item);
	second.acquire(secondKey);
	second.requestItem(item);
	await flush();

	assert.equal(loadCount, 1);
	assert.equal(first.getTexture(firstKey), texture);
	assert.equal(second.getTexture(secondKey), texture);

	first.destroy();
	await flush();
	assert.equal(unloadCount, 0);
	assert.equal(second.getTexture(secondKey), texture);
	assert.equal(texture.destroyed, false);

	second.destroy();
	await flush();
	assert.equal(unloadCount, 1);
});
