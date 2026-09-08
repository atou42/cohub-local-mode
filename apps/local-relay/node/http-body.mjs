import { createHash } from "node:crypto";
import { Readable } from "node:stream";

export const HTTP_BODY_PART_BYTES = 16 * 1024 * 1024;
export const HTTP_INLINE_BYTES = 128 * 1024;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function validateBodyParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > 128) throw new Error("Invalid HTTP body parts");
  const ids = new Set();
  for (const part of parts) {
    if (!part || !/^[a-f0-9-]{36}$/i.test(part.id) || ids.has(part.id) || !Number.isSafeInteger(part.size) || part.size < 1 || part.size > HTTP_BODY_PART_BYTES || !/^[a-f0-9]{64}$/.test(part.sha256)) throw new Error("Invalid HTTP body part identity");
    ids.add(part.id);
  }
  return parts;
}

export function requestBodyParts(parts, { fetcher, relayNodeBaseUrl, relayNodeToken, signal }) {
  validateBodyParts(parts);
  if (!relayNodeBaseUrl || !relayNodeToken) throw new Error("HTTP body relay authentication is missing");
  return Readable.from((async function* () {
    for (const part of parts) {
      const response = await fetcher(`${relayNodeBaseUrl}/attachments/${encodeURIComponent(part.id)}/content`, {
        headers: { authorization: `Bearer ${relayNodeToken}`, "x-cohub-relay-node": "1" }, signal,
      });
      if (!response.ok || Number(response.headers.get("content-length")) !== part.size || response.headers.get("x-cohub-attachment-sha256") !== part.sha256 || response.headers.get("x-cohub-attachment-id") !== part.id) throw new Error("HTTP body part download identity mismatch");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("HTTP body part content is missing");
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > part.size) { await reader.cancel(); throw new Error("HTTP body part size mismatch"); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      const bytes = Buffer.concat(chunks, size);
      if (size !== part.size || sha256(bytes) !== part.sha256) throw new Error("HTTP body part checksum mismatch");
      yield bytes;
    }
  })());
}

export async function responseBodyParts(response, { maxBytes, uploadPart }) {
  if (!response.body) return { bytes: Buffer.alloc(0) };
  const reader = response.body.getReader();
  const parts = [];
  let chunks = [];
  let pending = 0;
  let total = 0;
  const flush = async () => {
    const bytes = Buffer.concat(chunks, pending);
    chunks = [];
    pending = 0;
    if (!uploadPart) throw new Error("Large HTTP response requires relay body storage");
    if (parts.length >= 128) throw new Error("HTTP response exceeds the body part limit");
    const checksum = sha256(bytes);
    const id = await uploadPart(bytes, checksum);
    parts.push({ id, size: bytes.length, sha256: checksum });
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Local API response exceeds ${maxBytes} bytes`);
      for (let offset = 0; offset < value.byteLength;) {
        const size = Math.min(HTTP_BODY_PART_BYTES - pending, value.byteLength - offset);
        chunks.push(Buffer.from(value.subarray(offset, offset + size)));
        pending += size;
        offset += size;
        if (pending === HTTP_BODY_PART_BYTES) await flush();
      }
    }
    if (!parts.length && pending <= HTTP_INLINE_BYTES) return { bytes: Buffer.concat(chunks, pending) };
    if (pending) await flush();
    return { bodyParts: parts };
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}
