import { createHash, randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createLogger } from "@cohub/infra/logging";
import { config } from "./config.js";

const logger = createLogger({ serviceName: "cohub-api" });
const IMMUTABLE_PUBLIC_CACHE_CONTROL = "public, max-age=31536000, immutable";

let s3Client: S3Client | null = null;

const getS3Client = () => {
  if (!config.turnObjectS3Bucket)
    throw new Error(
      "TURN_OBJECT_S3_BUCKET is required for completion object storage",
    );
  if (!config.turnObjectS3Endpoint)
    throw new Error(
      "TURN_OBJECT_S3_ENDPOINT is required for completion object storage",
    );
  if (!config.turnObjectS3AccessKeyId || !config.turnObjectS3SecretAccessKey) {
    throw new Error(
      "TURN_OBJECT_S3_ACCESS_KEY_ID and TURN_OBJECT_S3_SECRET_ACCESS_KEY are required for completion object storage",
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

const envObjectKeyPrefix = () => (config.env === "dev" ? "dev/" : "");

export function createCompletionId() {
  return randomUUID();
}

export function buildCompletionObjectKey(input: {
  spaceId: string;
  completionId: string;
  at?: Date;
}) {
  const at = input.at ?? new Date();
  const yyyy = String(at.getUTCFullYear());
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(at.getUTCDate()).padStart(2, "0");
  return `${envObjectKeyPrefix()}spaces/${input.spaceId}/completions/${yyyy}/${mm}/${dd}/${input.completionId}.json`;
}

export type CompletionArchiveRecord = {
  completionId: string;
  spaceId: string;
  userId: string;
  provider: string;
  model: string;
  systemPromptPath: string | null;
  systemPrompt: string;
  request: {
    messages: unknown;
    contextFallbacks?: unknown;
    temperature?: number | null;
    maxTokens?: number | null;
    thinkingLevel?: string | null;
    stream: boolean;
  };
  response: {
    message: unknown;
    usage: unknown;
    stopReason?: string | null;
    errorMessage?: string | null;
  } | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  clientAborted: boolean;
  error: { code?: string; message: string } | null;
};

export async function writeCompletionArchive(record: CompletionArchiveRecord) {
  const objectKey = buildCompletionObjectKey({
    spaceId: record.spaceId,
    completionId: record.completionId,
    at: new Date(record.startedAt),
  });
  const content = `${JSON.stringify(record)}\n`;
  const sha256 = createHash("sha256").update(content).digest("hex");
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: config.turnObjectS3Bucket,
      Key: objectKey,
      Body: content,
      ContentType: "application/json; charset=utf-8",
      CacheControl: IMMUTABLE_PUBLIC_CACHE_CONTROL,
      Metadata: { sha256 },
    }),
  );
  return { objectKey, sha256 };
}

/** Fire-and-forget archive. Never throws to callers. */
export function archiveCompletionBestEffort(record: CompletionArchiveRecord) {
  void writeCompletionArchive(record).catch((error) => {
    logger.warn("[Completion] failed to archive completion", {
      completionId: record.completionId,
      spaceId: record.spaceId,
      error,
    });
  });
}
