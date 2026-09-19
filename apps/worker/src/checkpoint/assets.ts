import { createReadStream } from "node:fs";
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { config } from "../config.js";

const IMMUTABLE_PUBLIC_CACHE_CONTROL = "public, max-age=31536000, immutable";

let client: S3Client | null = null;

export const getCheckpointAssetClient = () => {
  if (!config.checkpointAssetOssBucket)
    throw new Error(
      "CHECKPOINT_ASSET_OSS_BUCKET is required for checkpoint assets",
    );
  if (!config.checkpointAssetOssEndpoint)
    throw new Error(
      "CHECKPOINT_ASSET_OSS_ENDPOINT is required for checkpoint assets",
    );
  if (
    !config.checkpointAssetOssAccessKeyId ||
    !config.checkpointAssetOssSecretAccessKey
  ) {
    throw new Error(
      "CHECKPOINT_ASSET_OSS_ACCESS_KEY_ID and CHECKPOINT_ASSET_OSS_SECRET_ACCESS_KEY are required for checkpoint assets",
    );
  }
  client ??= new S3Client({
    endpoint: config.checkpointAssetOssEndpoint,
    region: config.checkpointAssetOssRegion,
    forcePathStyle: config.s3ForcePathStyle,
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: config.checkpointAssetOssAccessKeyId,
      secretAccessKey: config.checkpointAssetOssSecretAccessKey,
    },
  });
  return client;
};

export const buildAssetObjectKey = (sha256: string) =>
  `checkpoint-assets/sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;

export const uploadObjectFileIfMissing = async (input: {
  filePath: string;
  objectKey: string;
  size: number;
  mimeType: string | null;
  metadata?: Record<string, string>;
}) => {
  const Bucket = config.checkpointAssetOssBucket as string;
  const s3 = getCheckpointAssetClient();
  const exists = await s3
    .send(new HeadObjectCommand({ Bucket, Key: input.objectKey }))
    .then(
      () => true,
      () => false,
    );
  if (!exists) {
    await s3.send(
      new PutObjectCommand({
        Bucket,
        Key: input.objectKey,
        Body: createReadStream(input.filePath),
        ContentLength: input.size,
        ContentType: input.mimeType ?? undefined,
        CacheControl: IMMUTABLE_PUBLIC_CACHE_CONTROL,
        Metadata: input.metadata,
      }),
    );
  }
  return input.objectKey;
};

export const uploadAssetIfMissing = async (input: {
  filePath: string;
  sha256: string;
  size: number;
  mimeType: string | null;
}) =>
  uploadObjectFileIfMissing({
    filePath: input.filePath,
    objectKey: buildAssetObjectKey(input.sha256),
    size: input.size,
    mimeType: input.mimeType,
    metadata: { sha256: input.sha256 },
  });
