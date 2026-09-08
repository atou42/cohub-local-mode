export type PersonalNodeBodyPart = { id: string; size: number; sha256: string };
const PART_BYTES = 16 * 1024 * 1024;
const INLINE_BYTES = 128 * 1024;
const digest = async (bytes: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");

export function validatePersonalNodeBodyParts(value: unknown): PersonalNodeBodyPart[] {
	if (!Array.isArray(value) || !value.length || value.length > 128) throw new Error("Personal Node body parts are invalid");
	const ids = new Set<string>();
	for (const part of value) {
		if (!part || !/^[a-f0-9-]{36}$/i.test(part.id) || ids.has(part.id) || !Number.isSafeInteger(part.size) || part.size < 1 || part.size > PART_BYTES || !/^[a-f0-9]{64}$/.test(part.sha256)) throw new Error("Personal Node body part identity is invalid");
		ids.add(part.id);
	}
	return value;
}

export async function uploadPersonalNodeBodyPart(bytes: Uint8Array<ArrayBuffer>, context: {
	basePath: string; authorization: string; assertCurrent: () => void; signal?: AbortSignal;
}): Promise<PersonalNodeBodyPart> {
	const sha256 = await digest(bytes);
	context.assertCurrent();
	const planned = await fetch(`${context.basePath}/attachments`, {
		method: "POST", headers: { authorization: context.authorization, "content-type": "application/json" },
		body: JSON.stringify({ name: "http-body.bin", size: bytes.length, contentType: "application/octet-stream", sha256 }), signal: context.signal,
	});
	if (!planned.ok) throw new Error(`HTTP body upload plan failed (${planned.status})`);
	const plan = await planned.json();
	context.assertCurrent();
	const id = plan.attachment?.id;
	validatePersonalNodeBodyParts([{ id, size: bytes.length, sha256 }]);
	const origin = typeof location === "undefined" ? "https://alpha.internal" : location.origin;
	const url = new URL(plan.upload?.url, origin);
	const expected = new URL(`${context.basePath}/attachments/${encodeURIComponent(id)}/content`, origin);
	if (url.origin !== expected.origin || url.pathname !== expected.pathname) throw new Error("HTTP body upload plan points outside the selected node");
	const uploaded = await fetch(url, {
		method: "PUT", headers: { authorization: context.authorization, "content-type": "application/octet-stream", "x-cohub-content-sha256": sha256 }, body: bytes, signal: context.signal,
	});
	context.assertCurrent();
	if (!uploaded.ok) throw new Error(`HTTP body upload failed (${uploaded.status})`);
	const ready = (await uploaded.json()).attachment;
	if (ready?.id !== id || ready.state !== "ready" || ready.size !== bytes.length || ready.sha256 !== sha256) throw new Error("HTTP body upload verification failed");
	return { id, size: bytes.length, sha256 };
}

export async function transferPersonalNodeRequestBody(request: Request, upload: (bytes: Uint8Array<ArrayBuffer>) => Promise<PersonalNodeBodyPart>) {
	const reader = request.body?.getReader();
	if (!reader) return { bytes: new Uint8Array(0) };
	let buffer = new Uint8Array(PART_BYTES);
	let length = 0;
	const bodyParts: PersonalNodeBodyPart[] = [];
	const flush = async () => {
		if (bodyParts.length >= 128) throw new Error("Personal Node request exceeds the body part limit");
		bodyParts.push(await upload(buffer.slice(0, length)));
		buffer = new Uint8Array(PART_BYTES);
		length = 0;
	};
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			for (let offset = 0; offset < value.length;) {
				const size = Math.min(PART_BYTES - length, value.length - offset);
				buffer.set(value.subarray(offset, offset + size), length);
				length += size;
				offset += size;
				if (length === PART_BYTES) await flush();
			}
		}
		if (!bodyParts.length && length <= INLINE_BYTES) return { bytes: buffer.slice(0, length) };
		if (length) await flush();
		return { bodyParts };
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally { reader.releaseLock(); }
}

export function personalNodeBodyStream(parts: PersonalNodeBodyPart[], context: {
	basePath: string; authorization: string; assertCurrent: () => void;
}) {
	validatePersonalNodeBodyParts(parts);
	let index = 0;
	const controller = new AbortController();
	return new ReadableStream<Uint8Array>({
		async pull(stream) {
			context.assertCurrent();
			const part = parts[index++];
			if (!part) { stream.close(); return; }
			const response = await fetch(`${context.basePath}/attachments/${encodeURIComponent(part.id)}/content`, { headers: { authorization: context.authorization }, signal: controller.signal });
			context.assertCurrent();
			if (!response.ok || Number(response.headers.get("content-length")) !== part.size || response.headers.get("x-cohub-attachment-id") !== part.id || response.headers.get("x-cohub-attachment-sha256") !== part.sha256) throw new Error("Personal Node response part identity mismatch");
			const reader = response.body?.getReader();
			if (!reader) throw new Error("Personal Node response part is missing");
			const bytes = new Uint8Array(part.size);
			let offset = 0;
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					if (offset + value.length > bytes.length) { await reader.cancel(); throw new Error("Personal Node response part size mismatch"); }
					bytes.set(value, offset);
					offset += value.length;
				}
			} finally { reader.releaseLock(); }
			if (offset !== part.size || await digest(bytes) !== part.sha256) throw new Error("Personal Node response part checksum mismatch");
			context.assertCurrent();
			stream.enqueue(bytes);
		},
		cancel(reason) { controller.abort(reason); },
	});
}
