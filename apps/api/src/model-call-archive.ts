import { createHash, randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createLogger } from "@cohub/infra/logging";
import { config } from "./config.js";

const logger = createLogger({ serviceName: "cohub-api" });
const IMMUTABLE_PUBLIC_CACHE_CONTROL = "public, max-age=31536000, immutable";

let s3Client: S3Client | null = null;

const getS3Client = () => {
  if (!config.turnObjectS3Bucket) throw new Error("TURN_OBJECT_S3_BUCKET is required for model call archives");
  if (!config.turnObjectS3Endpoint) throw new Error("TURN_OBJECT_S3_ENDPOINT is required for model call archives");
  if (!config.turnObjectS3AccessKeyId || !config.turnObjectS3SecretAccessKey) {
    throw new Error("TURN_OBJECT_S3_ACCESS_KEY_ID and TURN_OBJECT_S3_SECRET_ACCESS_KEY are required for model call archives");
  }
  s3Client ??= new S3Client({
    endpoint: config.turnObjectS3Endpoint,
    region: config.turnObjectS3Region,
    forcePathStyle: false,
    credentials: {
      accessKeyId: config.turnObjectS3AccessKeyId,
      secretAccessKey: config.turnObjectS3SecretAccessKey,
    },
  });
  return s3Client;
};

const envObjectKeyPrefix = () => (config.env === "dev" ? "dev/" : "");

export type ModelCallKind = "completions" | "decisions";

export function createModelCallId() {
  return randomUUID();
}

export function buildModelCallObjectKey(input: {
  kind: ModelCallKind;
  spaceId: string;
  id: string;
  at?: Date;
}) {
  const at = input.at ?? new Date();
  const yyyy = String(at.getUTCFullYear());
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(at.getUTCDate()).padStart(2, "0");
  return `${envObjectKeyPrefix()}spaces/${input.spaceId}/${input.kind}/${yyyy}/${mm}/${dd}/${input.id}.json`;
}

type ModelCallArchiveBase = {
  spaceId: string;
  userId: string;
  provider: string;
  model: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  clientAborted: boolean;
  error: { code?: string; message: string } | null;
};

export type CompletionArchiveRecord = ModelCallArchiveBase & {
  completionId: string;
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
};

export type DecisionArchiveRecord = ModelCallArchiveBase & {
  decisionId: string;
  request: unknown;
  attempts: Array<{
    status: number | null;
    body: unknown;
    error?: string;
    durationMs: number;
  }>;
  costUsd: number | null;
};

async function writeModelCallArchive(kind: ModelCallKind, id: string, record: ModelCallArchiveBase) {
  const objectKey = buildModelCallObjectKey({ kind, spaceId: record.spaceId, id, at: new Date(record.startedAt) });
  const content = `${JSON.stringify(record)}\n`;
  const sha256 = createHash("sha256").update(content).digest("hex");
  await getS3Client().send(new PutObjectCommand({
    Bucket: config.turnObjectS3Bucket,
    Key: objectKey,
    Body: content,
    ContentType: "application/json; charset=utf-8",
    CacheControl: IMMUTABLE_PUBLIC_CACHE_CONTROL,
    Metadata: { sha256 },
  }));
  return { objectKey, sha256 };
}

function archiveBestEffort(kind: ModelCallKind, id: string, record: ModelCallArchiveBase) {
  void writeModelCallArchive(kind, id, record).catch((error) => {
    logger.warn("[ModelCall] failed to archive", { kind, id, spaceId: record.spaceId, error });
  });
}

export const archiveCompletionBestEffort = (record: CompletionArchiveRecord) =>
  archiveBestEffort("completions", record.completionId, record);

export const archiveDecisionBestEffort = (record: DecisionArchiveRecord) =>
  archiveBestEffort("decisions", record.decisionId, record);
