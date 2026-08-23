import { createHash } from "node:crypto";
import { normalize } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "./env.js";

const IMMUTABLE_PUBLIC_CACHE_CONTROL = "public, max-age=31536000, immutable";

let s3Client: S3Client | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableStorageError = (error: unknown) => {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    $metadata?: { httpStatusCode?: number };
    name?: string;
    code?: string;
  };
  const status = value.$metadata?.httpStatusCode;
  if (typeof status === "number")
    return status === 408 || status === 429 || status >= 500;
  const code = value.name ?? value.code ?? "";
  return /Abort|Timeout|Throttl|SlowDown|Networking|ECONN|EAI_AGAIN|ETIMEDOUT/i.test(
    code,
  );
};

const getS3Client = () => {
  if (!env.TURN_OBJECT_S3_BUCKET)
    throw new Error(
      "TURN_OBJECT_S3_BUCKET is required for turn object storage",
    );
  if (!env.TURN_OBJECT_S3_ENDPOINT)
    throw new Error(
      "TURN_OBJECT_S3_ENDPOINT is required for turn object storage",
    );
  if (
    !env.TURN_OBJECT_S3_ACCESS_KEY_ID ||
    !env.TURN_OBJECT_S3_SECRET_ACCESS_KEY
  ) {
    throw new Error(
      "TURN_OBJECT_S3_ACCESS_KEY_ID and TURN_OBJECT_S3_SECRET_ACCESS_KEY are required for turn object storage",
    );
  }
  s3Client ??= new S3Client({
    endpoint: env.TURN_OBJECT_S3_ENDPOINT,
    region: env.TURN_OBJECT_S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.TURN_OBJECT_S3_ACCESS_KEY_ID,
      secretAccessKey: env.TURN_OBJECT_S3_SECRET_ACCESS_KEY,
    },
  });
  return s3Client;
};

export const sanitizeTurnObjectKey = (objectKey: string) => {
  const raw = objectKey.trim().replace(/^\/+/, "");
  if (!raw) throw new Error("invalid object key");
  const parts = raw.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("invalid object key");
  }
  const normalized = normalize(raw).replace(/^\/+/, "");
  if (
    normalized !== raw ||
    normalized.startsWith("..") ||
    normalized.includes("/../")
  ) {
    throw new Error("invalid object key");
  }
  return normalized;
};

const envObjectKeyPrefix = () => (env.ENV === "dev" ? "dev/" : "");

export const buildTurnObjectPrefix = (input: {
  spaceId: string;
  sessionId: string;
  turnId: string;
}) =>
  `${envObjectKeyPrefix()}spaces/${input.spaceId}/sessions/${input.sessionId}/turns/${input.turnId}/`;

export const writeTurnObjectJson = async (
  objectKey: string,
  value: unknown,
) => {
  const content = `${JSON.stringify(value)}\n`;
  const safeKey = sanitizeTurnObjectKey(objectKey);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const sizeBytes = Buffer.byteLength(content, "utf8");
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= env.TURN_OBJECT_S3_MAX_ATTEMPTS; attempt++) {
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      env.TURN_OBJECT_S3_TIMEOUT_MS,
    );
    try {
      await getS3Client().send(
        new PutObjectCommand({
          Bucket: env.TURN_OBJECT_S3_BUCKET,
          Key: safeKey,
          Body: content,
          ContentType: "application/json; charset=utf-8",
          CacheControl: IMMUTABLE_PUBLIC_CACHE_CONTROL,
          Metadata: { sha256 },
        }),
        { abortSignal: abortController.signal },
      );
      return { sizeBytes, sha256 };
    } catch (error) {
      lastError = error;
      if (
        attempt >= env.TURN_OBJECT_S3_MAX_ATTEMPTS ||
        !isRetryableStorageError(error)
      )
        break;
      await sleep(200 * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};
