import {
	assertRelayAttachmentFresh,
	RelayProtocolError,
	type RelayAttachment,
} from "./protocol.ts";

export type RelayAttachmentEnv = {
	ATTACHMENTS: R2Bucket;
	ATTACHMENT_MAX_BYTES: string;
	ATTACHMENT_TTL_MS: string;
};

type RelayAttachmentStub = {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

function json(value: unknown, status = 200) {
	return Response.json(value, {
		status,
		headers: { "cache-control": "no-store" },
	});
}

function bytesToHex(value: ArrayBuffer | ArrayBufferView) {
	const bytes =
		value instanceof ArrayBuffer
			? new Uint8Array(value)
			: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	return [...bytes]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function readInternalAttachment(
	response: Response,
): Promise<{ attachment: RelayAttachment; alreadyUploaded?: boolean }> {
	const payload = await response.json<{
		attachment?: RelayAttachment;
		alreadyUploaded?: boolean;
	}>();
	if (!response.ok || !payload.attachment) {
		throw new RelayProtocolError(
			"attachment_state_unavailable",
			"Attachment state is unavailable",
			response.status >= 400 ? response.status : 500,
		);
	}
	return {
		attachment: payload.attachment,
		...(payload.alreadyUploaded === undefined
			? {}
			: { alreadyUploaded: payload.alreadyUploaded }),
	};
}

export async function createAttachmentPlan(input: {
	request: Request;
	url: URL;
	stub: RelayAttachmentStub;
	nodeId: string;
	publicBasePath?: string;
}) {
	const created = await input.stub.fetch(
		new Request("https://relay.internal/internal/attachments", input.request),
	);
	const payload = await created.json<{
		attachment?: RelayAttachment;
		uploadToken?: string;
		code?: string;
		message?: string;
	}>();
	if (!created.ok || !payload.attachment || !payload.uploadToken) {
		return json(payload, created.status);
	}
	const publicBasePath =
		input.publicBasePath ??
		`${input.url.pathname.startsWith("/relay/") ? "/relay" : ""}/v1/nodes/${encodeURIComponent(input.nodeId)}`;
	const uploadUrl = new URL(
		`${publicBasePath}/attachments/${encodeURIComponent(payload.attachment.id)}/content`,
		input.url.origin,
	);
	uploadUrl.searchParams.set("uploadToken", payload.uploadToken);
	return json(
		{
			attachment: payload.attachment,
			upload: {
				method: "PUT",
				url: uploadUrl.toString(),
				headers: {
					"content-type": payload.attachment.contentType,
					"x-cohub-content-sha256": payload.attachment.sha256,
				},
				expiresAt: payload.attachment.expiresAt,
			},
		},
		201,
	);
}

function attachmentContentDisposition(name: string) {
	const fallback = name.replace(/[^a-z0-9._-]/gi, "_") || "attachment";
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function handleAttachmentUpload(input: {
	request: Request;
	env: RelayAttachmentEnv;
	stub: RelayAttachmentStub;
	nodeId: string;
	attachmentId: string;
}) {
	const { request, env, stub, nodeId, attachmentId } = input;
	const url = new URL(request.url);
	const token = url.searchParams.get("uploadToken") ?? "";
	const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
	const declaredSha256 =
		request.headers.get("x-cohub-content-sha256")?.toLowerCase() ?? "";
	const rawLength = request.headers.get("content-length");
	const size = rawLength === null ? Number.NaN : Number(rawLength);
	const authorization = await stub.fetch(
		`https://relay.internal/internal/attachments/${encodeURIComponent(attachmentId)}/authorize-upload`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token, size, contentType, sha256: declaredSha256 }),
		},
	);
	const { attachment, alreadyUploaded } =
		await readInternalAttachment(authorization);
	if (alreadyUploaded) return json({ attachment, deduplicated: true });
	if (!request.body) {
		throw new RelayProtocolError(
			"attachment_body_missing",
			"Attachment body is required",
		);
	}
	let uploaded: R2Object;
	try {
		uploaded = await env.ATTACHMENTS.put(attachment.objectKey, request.body, {
			httpMetadata: { contentType: attachment.contentType },
			customMetadata: {
				nodeId,
				attachmentId,
				originalName: attachment.name,
			},
			sha256: attachment.sha256,
		});
	} catch (error) {
		console.error("[relay] R2 attachment upload failed", {
			attachmentId,
			error,
		});
		throw new RelayProtocolError(
			"attachment_upload_failed",
			"Attachment upload failed checksum or storage validation",
			422,
		);
	}
	const storedSha256 = uploaded.checksums.sha256
		? bytesToHex(uploaded.checksums.sha256)
		: null;
	if (
		uploaded.size !== attachment.size ||
		uploaded.httpMetadata?.contentType !== attachment.contentType ||
		storedSha256 !== attachment.sha256 ||
		uploaded.customMetadata?.attachmentId !== attachment.id ||
		uploaded.customMetadata?.nodeId !== attachment.nodeId
	) {
		await env.ATTACHMENTS.delete(attachment.objectKey);
		throw new RelayProtocolError(
			"attachment_verification_failed",
			"Stored attachment failed identity verification",
			422,
		);
	}
	const completed = await stub.fetch(
		`https://relay.internal/internal/attachments/${encodeURIComponent(attachmentId)}/complete`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				objectKey: attachment.objectKey,
				size: uploaded.size,
				contentType: uploaded.httpMetadata?.contentType,
				sha256: storedSha256,
			}),
		},
	);
	const ready = await readInternalAttachment(completed);
	return json({ attachment: ready.attachment, deduplicated: false }, 201);
}

export async function handleAttachmentDownload(input: {
	env: RelayAttachmentEnv;
	stub: RelayAttachmentStub;
	attachmentId: string;
}) {
	const response = await input.stub.fetch(
		`https://relay.internal/internal/attachments/${encodeURIComponent(input.attachmentId)}`,
	);
	const { attachment } = await readInternalAttachment(response);
	if (attachment.state !== "ready") {
		throw new RelayProtocolError(
			"attachment_not_ready",
			"Attachment is not ready",
			409,
		);
	}
	assertRelayAttachmentFresh(attachment.expiresAt);
	const object = await input.env.ATTACHMENTS.get(attachment.objectKey);
	if (!object) {
		throw new RelayProtocolError(
			"attachment_object_missing",
			"Attachment object is missing",
			502,
		);
	}
	const storedSha256 = object.checksums.sha256
		? bytesToHex(object.checksums.sha256)
		: null;
	if (
		object.size !== attachment.size ||
		object.httpMetadata?.contentType !== attachment.contentType ||
		storedSha256 !== attachment.sha256 ||
		object.customMetadata?.attachmentId !== attachment.id
	) {
		throw new RelayProtocolError(
			"attachment_verification_failed",
			"Attachment object no longer matches its verified identity",
			502,
		);
	}
	return new Response(object.body, {
		headers: {
			"cache-control": "private, no-store",
			"content-disposition": attachmentContentDisposition(attachment.name),
			"content-length": String(attachment.size),
			"content-type": attachment.contentType,
			"x-cohub-attachment-id": attachment.id,
			"x-cohub-attachment-sha256": attachment.sha256,
			"x-cohub-attachment-size": String(attachment.size),
			"x-content-type-options": "nosniff",
		},
	});
}
