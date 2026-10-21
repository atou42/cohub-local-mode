import assert from "node:assert/strict";
import test from "node:test";
import { ImageLoader, Mesh, MeshStandardMaterial } from "three";
import { loadModel } from "$lib/model3d/load";

const obj = (libraries: string[]) =>
	new TextEncoder().encode(
		`${libraries.map((name) => `mtllib ${name}`).join("\n")}\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl surface\nf 1 2 3\n`,
	);

test("OBJ textures resolve relative to their MTL, keeping material options", async (t) => {
	const loaded: string[] = [];
	t.mock.method(
		globalThis,
		"fetch",
		async () => new Response("newmtl surface\nmap_Kd -s 2 3 1 albedo.png\n"),
	);
	t.mock.method(
		ImageLoader.prototype,
		"load",
		function (
			this: ImageLoader,
			url: string,
			onLoad?: (image: HTMLImageElement) => void,
		) {
			const resolved = this.manager.resolveURL(url);
			loaded.push(resolved);
			this.manager.itemStart(resolved);
			const image = { width: 1, height: 1 } as HTMLImageElement;
			queueMicrotask(() => {
				onLoad?.(image);
				this.manager.itemEnd(resolved);
			});
			return image;
		},
	);
	const references: [string, string | undefined][] = [];
	const result = await loadModel({
		format: "obj",
		bytes: obj(["materials/model.mtl"]),
		resolveReference: async (reference, relativeTo) => {
			references.push([reference, relativeTo]);
			return relativeTo
				? "https://cdn.example/materials/albedo.png"
				: "https://cdn.example/materials/model.mtl";
		},
	});
	assert.deepEqual(references, [
		["materials/model.mtl", undefined],
		["albedo.png", "materials/model.mtl"],
	]);
	assert.deepEqual(loaded, ["https://cdn.example/materials/albedo.png"]);
	assert.deepEqual(result.missing, []);
	const mesh = result.root.children[0];
	assert.ok(mesh instanceof Mesh);
	assert.ok(mesh.material instanceof MeshStandardMaterial);
	assert.deepEqual(mesh.material.map?.repeat.toArray(), [2, 3]);
});

test("failed MTL downloads are reported without blocking OBJ geometry", async (t) => {
	t.mock.method(
		globalThis,
		"fetch",
		async (url: Parameters<typeof fetch>[0]) => {
			if (String(url).endsWith("network.mtl"))
				throw new TypeError("Network error");
			return new Response("Not found", { status: 404 });
		},
	);
	const result = await loadModel({
		format: "obj",
		bytes: obj(["network.mtl", "missing.mtl"]),
		resolveReference: async (reference) => `https://cdn.example/${reference}`,
	});
	assert.deepEqual(result.missing.sort(), ["missing.mtl", "network.mtl"]);
	const mesh = result.root.children[0];
	assert.ok(mesh instanceof Mesh);
	assert.equal(mesh.geometry.getAttribute("position").count, 3);
});
