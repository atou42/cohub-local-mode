import { createReadStream } from "node:fs";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_DELAY_MS = 200;

const RETRYABLE_STATUS = new Set([408, 411, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set([
  "BodyTimeoutError",
  "ConnectTimeoutError",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "HeadersTimeoutError",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export class HttpPutError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body = "") {
    super(message);
    this.name = "HttpPutError";
    this.status = status;
    this.body = body;
  }
}

export type PutRetryOptions = {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
};

type PutWithRetryInput = PutRetryOptions & {
  url: string;
  body: () => BodyInit;
  headers?: HeadersInit;
  contentLength?: number;
  duplex?: boolean;
  label: string;
};

function withContentLength(headers: HeadersInit | undefined, contentLength?: number): Headers {
  const result = new Headers(headers);
  if (contentLength !== undefined && !result.has("content-length")) {
    result.set("content-length", String(contentLength));
  }
  return result;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { code?: unknown; name?: unknown; cause?: { code?: unknown; name?: unknown } };
  if (typeof record.code === "string") return record.code;
  if (typeof record.cause?.code === "string") return record.cause.code;
  if (typeof record.cause?.name === "string") return record.cause.name;
  if (typeof record.name === "string") return record.name;
  return undefined;
}

function isRetryableError(error: unknown): boolean {
  const code = errorCode(error);
  return Boolean(code && RETRYABLE_CODES.has(code));
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failureMessage(label: string, status: number, detail: string): string {
  return `Failed to upload ${label}: HTTP ${status}${detail ? ` — ${detail}` : ""}`;
}

async function putWithRetry(input: PutWithRetryInput): Promise<Response> {
  const attempts = input.attempts ?? DEFAULT_ATTEMPTS;
  const delayMs = input.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = input.sleep ?? defaultSleep;
  const fetchImpl = input.fetch ?? fetch;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(input.url, {
        method: "PUT",
        headers: withContentLength(input.headers, input.contentLength),
        body: input.body(),
        ...(input.duplex ? { duplex: "half" as const } : {}),
      } as RequestInit);
      if (response.ok) return response;
      const detail = await response.text().catch(() => "");
      const error = new HttpPutError(failureMessage(input.label, response.status, detail), response.status, detail);
      if (attempt < attempts - 1 && isRetryableStatus(response.status)) {
        lastError = error;
        await sleep(delayMs * 2 ** attempt);
        continue;
      }
      throw error;
    } catch (error) {
      if (error instanceof HttpPutError) throw error;
      lastError = error;
      if (attempt < attempts - 1 && isRetryableError(error)) {
        await sleep(delayMs * 2 ** attempt);
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}

export async function putLocalFile(input: PutRetryOptions & {
  url: string;
  filePath: string;
  size: number;
  headers?: HeadersInit;
  label: string;
}): Promise<void> {
  await putWithRetry({
    url: input.url,
    body: () => createReadStream(input.filePath) as unknown as BodyInit,
    headers: input.headers,
    contentLength: input.size,
    duplex: true,
    label: input.label,
    attempts: input.attempts,
    delayMs: input.delayMs,
    sleep: input.sleep,
    fetch: input.fetch,
  });
}

export async function putBytes(input: PutRetryOptions & {
  url: string;
  body: Blob;
  size?: number;
  headers?: HeadersInit;
  label: string;
}): Promise<void> {
  const body = input.body;
  await putWithRetry({
    url: input.url,
    body: () => body,
    headers: input.headers,
    contentLength: input.size,
    label: input.label,
    attempts: input.attempts,
    delayMs: input.delayMs,
    sleep: input.sleep,
    fetch: input.fetch,
  });
}
