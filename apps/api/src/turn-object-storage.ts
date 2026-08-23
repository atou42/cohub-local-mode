import { createHash } from "node:crypto";
import { normalize } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "./config.js";

const CDN_BASE_URL = config.turnObjectCdnBaseUrl;
const IMMUTABLE_PUBLIC_CACHE_CONTROL = "public, max-age=31536000, immutable";

let s3Client: S3Client | null = null;
const getS3Client = () => {
  if (!config.turnObjectS3Bucket)
    throw new Error(
      "TURN_OBJECT_S3_BUCKET is required for turn object storage",
    );
  if (!config.turnObjectS3Endpoint)
    throw new Error(
      "TURN_OBJECT_S3_ENDPOINT is required for turn object storage",
    );
  if (!config.turnObjectS3AccessKeyId || !config.turnObjectS3SecretAccessKey) {
    throw new Error(
      "TURN_OBJECT_S3_ACCESS_KEY_ID and TURN_OBJECT_S3_SECRET_ACCESS_KEY are required for turn object storage",
    );
  }
  s3Client ??= new S3Client({
    endpoint: config.turnObjectS3Endpoint,
    region: config.turnObjectS3Region,
    forcePathStyle: config.s3ForcePathStyle,
    credentials: {
      accessKeyId: config.turnObjectS3AccessKeyId,
      secretAccessKey: config.turnObjectS3SecretAccessKey,
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

const envObjectKeyPrefix = () => (config.env === "dev" ? "dev/" : "");

export const buildTurnObjectPrefix = (input: {
  spaceId: string;
  sessionId: string;
  turnId: string;
}) =>
  `${envObjectKeyPrefix()}spaces/${input.spaceId}/sessions/${input.sessionId}/turns/${input.turnId}/`;

export const assertTurnObjectKeyInScope = (input: {
  objectKey: string;
  prefix: string;
}) => {
  const safeKey = sanitizeTurnObjectKey(input.objectKey);
  const safePrefix = sanitizeTurnObjectKey(input.prefix).replace(/\/?$/, "/");
  if (!safeKey.startsWith(safePrefix))
    throw new Error("object key is outside of turn scope");
  return safeKey;
};

export const assertTurnObjectKeyForTurn = (input: {
  objectKey: string;
  spaceId: string;
  sessionId: string;
  turnId: string;
}) => {
  const safeKey = sanitizeTurnObjectKey(input.objectKey);
  const parts = safeKey.split("/");
  const spacesIndex = parts.indexOf("spaces");
  if (
    spacesIndex < 0 ||
    parts[spacesIndex + 1] !== input.spaceId ||
    parts[spacesIndex + 2] !== "sessions" ||
    parts[spacesIndex + 3] !== input.sessionId ||
    parts[spacesIndex + 4] !== "turns" ||
    parts[spacesIndex + 5] !== input.turnId ||
    parts.length <= spacesIndex + 6
  ) {
    throw new Error("object key is outside of turn scope");
  }
  return safeKey;
};

export const writeTurnObjectJson = async (
  objectKey: string,
  value: unknown,
) => {
  const content = `${JSON.stringify(value)}\n`;
  const safeKey = sanitizeTurnObjectKey(objectKey);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const sizeBytes = Buffer.byteLength(content, "utf8");

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: config.turnObjectS3Bucket,
      Key: safeKey,
      Body: content,
      ContentType: "application/json; charset=utf-8",
      CacheControl: IMMUTABLE_PUBLIC_CACHE_CONTROL,
      Metadata: { sha256 },
    }),
  );
  return { sizeBytes, sha256 };
};

export const createTurnObjectCdnUrl = (objectKey: string) => {
  const safeKey = sanitizeTurnObjectKey(objectKey);
  return {
    objectKey: safeKey,
    url: `${CDN_BASE_URL}/${safeKey.split("/").map(encodeURIComponent).join("/")}`,
    expiresAt: null as string | null,
  };
};
