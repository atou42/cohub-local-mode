export async function proxyUploadStream(input: {
  body: ReadableStream<Uint8Array> | null;
  size: number;
  uploadUrl: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}, fetcher: typeof fetch = fetch) {
  if (!Number.isSafeInteger(input.size) || input.size < 0) throw new Error("Upload size is invalid");
  if (!input.body && input.size > 0) throw new Error("Upload body is missing");
  let received = 0;
  const limited = input.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > input.size) throw new Error("Upload body exceeds the planned size");
      controller.enqueue(chunk);
    },
    flush() {
      if (received !== input.size) throw new Error("Upload body does not match the planned size");
    },
  }));
  const response = await fetcher(input.uploadUrl, {
    method: "PUT", headers: { ...input.headers, "content-length": String(input.size) },
    body: limited ?? new Uint8Array(0), signal: input.signal,
    ...({ duplex: "half" } as Record<string, string>), redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Upload storage returned HTTP ${response.status}`);
  }
  await response.body?.cancel();
  if (received !== input.size) throw new Error("Upload storage did not consume the planned body");
}
