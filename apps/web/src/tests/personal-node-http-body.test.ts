import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { personalNodeBodyStream, transferPersonalNodeRequestBody, uploadPersonalNodeBodyPart } from "$lib/personal-node-http-body";

const checksum = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("large binary bodies roundtrip without inline JSON or text conversion", async (t) => {
	const bytes = new Uint8Array(17 * 1024 * 1024 + 7).fill(0xff);
	bytes.set([0x50, 0x4b, 0, 0x80]);
	const objects = new Map<string, Uint8Array>();
	const body = await transferPersonalNodeRequestBody(new Request("https://api.test/upload", { method: "PUT", body: bytes }), async (part) => {
		const id = randomUUID();
		objects.set(id, part);
		return { id, size: part.length, sha256: checksum(part) };
	});
	assert.equal(body.bodyParts?.length, 2);
	assert.equal(body.bytes, undefined);
	t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
		const id = String(input).split("/").at(-2)!;
		const bytes = objects.get(id)!;
		return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-length": String(bytes.length), "x-cohub-attachment-id": id, "x-cohub-attachment-sha256": checksum(bytes) } });
	});
	const restored = new Uint8Array(await new Response(personalNodeBodyStream(body.bodyParts!, { basePath: "/api/alpha/v1/nodes/test", authorization: "Bearer test", assertCurrent: () => {} })).arrayBuffer());
	assert.equal(restored.length, bytes.length);
	assert.equal(checksum(restored), checksum(bytes));
});

test("body upload refuses an external upload target without forwarding credentials", async (t) => {
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		calls++;
		return Response.json({ attachment: { id: randomUUID() }, upload: { url: "https://external.test/collect" } });
	});
	await assert.rejects(uploadPersonalNodeBodyPart(new Uint8Array([1]), { basePath: "/api/alpha/v1/nodes/test", authorization: "Bearer test", assertCurrent: () => {} }), /outside the selected node/);
	assert.equal(calls, 1);
});

test("late account switches and corrupt response checksums fail rather than leaking data", async (t) => {
	const part = { id: randomUUID(), size: 4, sha256: checksum(new TextEncoder().encode("good")) };
	t.mock.method(globalThis, "fetch", async () => new Response("evil", { headers: { "content-length": "4", "x-cohub-attachment-id": part.id, "x-cohub-attachment-sha256": part.sha256 } }));
	await assert.rejects(new Response(personalNodeBodyStream([part], { basePath: "/nodes/test", authorization: "Bearer test", assertCurrent: () => {} })).text(), /checksum mismatch/);
	await assert.rejects(new Response(personalNodeBodyStream([part], { basePath: "/nodes/test", authorization: "Bearer test", assertCurrent: () => { throw new Error("account changed"); } })).text(), /account changed/);
});
