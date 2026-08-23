import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type {
  PublicFileCreateUploadInput,
  PublicFileCreateUploadResponse,
  PublicFileListEntry,
  PublicFileListResponse,
  PublicFileUrlResponse,
} from "@cohub/protocol";
import { config } from "./config.js";
import { redisCommandClient } from "./redis.js";
import {
  createPresignedPutObjectUrl,
  type PresignStorageConfig,
} from "./object-presign.js";

export const MAX_PUBLIC_FILE_BYTES = 1024 * 1024 * 1024;
export const MAX_PUBLIC_UPLOAD_BYTES = 1024 * 1024 * 1024;
export const MAX_PUBLIC_UPLOAD_FILES = 1000;
export const PUBLIC_FILE_CACHE_CONTROL =
  "public, max-age=300, stale-while-revalidate=3600";

const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;
const PUBLIC_UPLOAD_QUOTA_WINDOW_SECONDS = 60 * 60;
const PUBLIC_UPLOAD_USER_MAX_FILES = 3000;
const PUBLIC_UPLOAD_SPACE_MAX_FILES = 10_000;
const PUBLIC_UPLOAD_USER_MAX_BYTES = 10 * 1024 * 1024 * 1024;
const PUBLIC_UPLOAD_SPACE_MAX_BYTES = 50 * 1024 * 1024 * 1024;

export class PublicFileConfigError extends Error {
  override name = "PublicFileConfigError";
}

export class PublicFileValidationError extends Error {
  override name = "PublicFileValidationError";
}

export class PublicFileRateLimitError extends Error {
  override name = "PublicFileRateLimitError";
}

type RequiredStorage = PresignStorageConfig & {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

let s3Client: S3Client | null = null;

const getStorage = (): PresignStorageConfig => ({
  endpoint: config.publicAssetOssEndpoint,
  publicEndpoint: config.publicAssetOssPublicEndpoint,
  region: config.publicAssetOssRegion,
  bucket: config.publicAssetOssBucket,
  accessKeyId: config.publicAssetOssAccessKeyId,
  secretAccessKey: config.publicAssetOssSecretAccessKey,
});

const requireStorage = (): RequiredStorage => {
  const storage = getStorage();
  if (
    !storage.endpoint ||
    !storage.bucket ||
    !storage.accessKeyId ||
    !storage.secretAccessKey
  ) {
    throw new PublicFileConfigError("public file storage is not configured");
  }
  return {
    ...storage,
    endpoint: storage.endpoint,
    bucket: storage.bucket,
    accessKeyId: storage.accessKeyId,
    secretAccessKey: storage.secretAccessKey,
  };
};

const getS3Client = () => {
  const storage = requireStorage();
  s3Client ??= new S3Client({
    endpoint: storage.endpoint,
    region: storage.region,
    forcePathStyle: config.s3ForcePathStyle,
    credentials: {
      accessKeyId: storage.accessKeyId,
      secretAccessKey: storage.secretAccessKey,
    },
  });
  return s3Client;
};

const envPrefix = () => (config.env === "prod" ? "" : `${config.env}/`);
const spacePrefix = (spaceId: string) => `${envPrefix()}p/${spaceId}/`;

export function normalizePublicFilePath(
  input: string,
  options: { allowEmpty?: boolean } = {},
) {
  if (typeof input !== "string")
    throw new PublicFileValidationError("invalid public path");
  const value = input
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (!value) {
    if (options.allowEmpty) return "";
    throw new PublicFileValidationError("public path is required");
  }
  if (
    value.startsWith("/") ||
    value.length > 4096 ||
    [...value].some((char) => {
      const code = char.charCodeAt(0);
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    })
  ) {
    throw new PublicFileValidationError("invalid public path");
  }
  const parts = value.split("/");
  if (
    parts.some(
      (part) => !part || part === "." || part === ".." || part.length > 255,
    )
  ) {
    throw new PublicFileValidationError("invalid public path");
  }
  return parts.join("/");
}

export const buildPublicFileObjectKey = (spaceId: string, path: string) =>
  `${spacePrefix(spaceId)}${normalizePublicFilePath(path)}`;

export const buildPublicFileUrl = (spaceId: string, path: string) => {
  const objectKey = buildPublicFileObjectKey(spaceId, path);
  const baseUrl = config.publicAssetCdnBaseUrl;
  if (!baseUrl)
    throw new PublicFileConfigError("PUBLIC_ASSET_CDN_BASE_URL is required");
  return `${baseUrl}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
};

async function consumeQuota(key: string, count: number, max: number) {
  const next = await redisCommandClient.incrby(key, count);
  if (next === count)
    await redisCommandClient.expire(key, PUBLIC_UPLOAD_QUOTA_WINDOW_SECONDS);
  if (next <= max) return;
  await redisCommandClient.decrby(key, count).catch(() => undefined);
  throw new PublicFileRateLimitError(
    "too many public uploads, please try again later",
  );
}

export async function consumePublicFileUploadQuota(input: {
  userId: string;
  spaceId: string;
  entryCount: number;
  totalBytes: number;
}) {
  const quotas = [
    [
      `public_file_upload:user:${input.userId}:files`,
      input.entryCount,
      PUBLIC_UPLOAD_USER_MAX_FILES,
    ],
    [
      `public_file_upload:user:${input.userId}:bytes`,
      input.totalBytes,
      PUBLIC_UPLOAD_USER_MAX_BYTES,
    ],
    [
      `public_file_upload:space:${input.spaceId}:files`,
      input.entryCount,
      PUBLIC_UPLOAD_SPACE_MAX_FILES,
    ],
    [
      `public_file_upload:space:${input.spaceId}:bytes`,
      input.totalBytes,
      PUBLIC_UPLOAD_SPACE_MAX_BYTES,
    ],
  ] as const;
  const consumed: Array<{ key: string; count: number }> = [];
  try {
    for (const [key, rawCount, max] of quotas) {
      const count = Math.max(0, Math.floor(rawCount));
      if (count === 0) continue;
      await consumeQuota(key, count, max);
      consumed.push({ key, count });
    }
  } catch (error) {
    await Promise.all(
      consumed.map(({ key, count }) =>
        redisCommandClient.decrby(key, count).catch(() => undefined),
      ),
    );
    throw error;
  }
}

function normalizeMimeType(value: string | null | undefined) {
  if (value == null || value === "") return "application/octet-stream";
  const mimeType = value.trim().toLowerCase();
  if (
    !/^[a-z0-9!#$&\-^_.+]{1,127}\/[a-z0-9!#$&\-^_.+]{1,127}(?:\s*;\s*charset=[a-z0-9._-]+)?$/i.test(
      mimeType,
    )
  ) {
    throw new PublicFileValidationError("invalid mime type");
  }
  return mimeType;
}

export function createPublicFileUpload(
  spaceId: string,
  input: PublicFileCreateUploadInput,
  options: { endpoint?: "internal" | "public" } = {},
): PublicFileCreateUploadResponse {
  if (!input?.entries?.length)
    throw new PublicFileValidationError("entries are required");
  if (input.overwrite != null && typeof input.overwrite !== "boolean") {
    throw new PublicFileValidationError("overwrite must be a boolean");
  }
  if (input.entries.length > MAX_PUBLIC_UPLOAD_FILES)
    throw new PublicFileValidationError("too many files");

  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  const entries = input.entries.map((entry) => {
    if (
      typeof entry.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.id) ||
      seenIds.has(entry.id)
    ) {
      throw new PublicFileValidationError(
        "entry ids must be unique safe strings",
      );
    }
    seenIds.add(entry.id);
    const path = normalizePublicFilePath(entry.relativePath);
    if (seenPaths.has(path))
      throw new PublicFileValidationError("duplicate public path");
    seenPaths.add(path);
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > MAX_PUBLIC_FILE_BYTES
    ) {
      throw new PublicFileValidationError("file too large");
    }
    totalBytes += entry.size;
    if (totalBytes > MAX_PUBLIC_UPLOAD_BYTES)
      throw new PublicFileValidationError("upload too large");
    return {
      id: entry.id,
      path,
      size: entry.size,
      mimeType: normalizeMimeType(entry.mimeType),
      objectKey: buildPublicFileObjectKey(spaceId, path),
    };
  });

  return {
    entries: entries.map((entry) => {
      const storage = requireStorage();
      const signed = createPresignedPutObjectUrl(
        options.endpoint === "internal"
          ? { ...storage, publicEndpoint: storage.endpoint }
          : storage,
        entry.objectKey,
        entry.mimeType,
        PUBLIC_FILE_CACHE_CONTROL,
        undefined,
        {
          contentLength: entry.size,
          forbidOverwrite: !input.overwrite,
        },
      );
      return {
        id: entry.id,
        path: entry.path,
        uploadUrl: signed.uploadUrl,
        publicUrl: buildPublicFileUrl(spaceId, entry.path),
        headers: signed.headers,
      };
    }),
  };
}

export async function listPublicFiles(
  spaceId: string,
  inputPath: string,
  options: {
    recursive?: boolean;
    limit?: number;
    cursor?: string;
  } = {},
): Promise<PublicFileListResponse> {
  const path = normalizePublicFilePath(inputPath, { allowEmpty: true });
  const rootPrefix = spacePrefix(spaceId);
  const prefix = `${rootPrefix}${path ? `${path}/` : ""}`;
  const limit = Math.min(
    MAX_LIST_LIMIT,
    Math.max(1, options.limit ?? DEFAULT_LIST_LIMIT),
  );
  const result = await getS3Client().send(
    new ListObjectsV2Command({
      Bucket: requireStorage().bucket,
      Prefix: prefix,
      Delimiter: options.recursive ? undefined : "/",
      ContinuationToken: options.cursor,
      MaxKeys: limit,
    }),
  );
  const entries: PublicFileListEntry[] = [];
  for (const item of result.CommonPrefixes ?? []) {
    if (!item.Prefix) continue;
    const itemPath = item.Prefix.slice(rootPrefix.length).replace(/\/$/, "");
    entries.push({
      path: itemPath,
      name: itemPath.split("/").at(-1) ?? itemPath,
      kind: "directory",
      size: null,
      updatedAt: null,
      publicUrl: null,
    });
  }
  for (const item of result.Contents ?? []) {
    if (!item.Key || item.Key === prefix) continue;
    const itemPath = item.Key.slice(rootPrefix.length);
    const relativeName =
      path && itemPath.startsWith(`${path}/`)
        ? itemPath.slice(path.length + 1)
        : itemPath;
    entries.push({
      path: itemPath,
      name: options.recursive
        ? relativeName
        : (itemPath.split("/").at(-1) ?? itemPath),
      kind: "file",
      size: item.Size ?? 0,
      updatedAt: item.LastModified?.toISOString() ?? null,
      publicUrl: buildPublicFileUrl(spaceId, itemPath),
    });
  }

  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  return {
    path,
    entries,
    nextCursor: result.IsTruncated
      ? (result.NextContinuationToken ?? null)
      : null,
  };
}

export function getPublicFileUrl(
  spaceId: string,
  inputPath: string,
): PublicFileUrlResponse {
  const path = normalizePublicFilePath(inputPath);
  return { path, url: buildPublicFileUrl(spaceId, path) };
}
