#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const envFile = resolve(
  process.env.COHUB_LOCAL_ENV_FILE ?? join(repoRoot, "deploy/local-mode/.env"),
);
const dataDir = resolve(
  process.env.COHUB_LOCAL_DATA_DIR ?? join(homedir(), ".cohub-local-mode"),
);

if (!isAbsolute(dataDir))
  throw new Error("COHUB_LOCAL_DATA_DIR must be an absolute path");

try {
  await access(envFile);
  console.log(`Local Mode environment already exists: ${envFile}`);
  console.log("Existing secrets and settings were left unchanged.");
  process.exit(0);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const secret = () => randomBytes(32).toString("base64url");
const postgresPassword = secret();
const redisPassword = secret();
const minioPassword = secret();
const encryptionKey = secret();
const workerSecret = secret();
const envValue = (value) => {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
};

const values = {
  COHUB_LOCAL_DATA_DIR: dataDir,
  POSTGRES_PASSWORD: postgresPassword,
  REDIS_PASSWORD: redisPassword,
  MINIO_ROOT_USER: "cohub-local",
  MINIO_ROOT_PASSWORD: minioPassword,
  APP_ENCRYPTION_KEY: encryptionKey,
  WORKER_SECRET: workerSecret,
  LOCAL_POSTGRES_PORT: "54329",
  LOCAL_REDIS_PORT: "6380",
  LOCAL_MINIO_PORT: "9000",
  LOCAL_MINIO_CONSOLE_PORT: "9001",
  DATABASE_URL: `postgresql://cohub:${postgresPassword}@127.0.0.1:54329/cohub`,
  REDIS_URL: `redis://:${redisPassword}@127.0.0.1:6380`,
  BULLMQ_REDIS_URL: `redis://:${redisPassword}@127.0.0.1:6380`,
  COHUB_NODE_ORIGIN: "local",
  ENV: "prod",
  NODE_ENV: "production",
  SESSIONS_NAMESPACE: "cohub-local",
  API_BASE_URL: "http://127.0.0.1:8787",
  INTERNAL_API_BASE_URL: "http://127.0.0.1:8787",
  HOST: "127.0.0.1",
  WEB_ORIGIN: "http://127.0.0.1:4173",
  PUBLIC_API_ORIGIN: "http://127.0.0.1:8787",
  PUBLIC_GATEWAY_ORIGIN: "ws://127.0.0.1:8788/ws",
  PUBLIC_COHUB_LOCAL_MODE: "true",
  PUBLIC_COHUB_ENV: "prod",
  PUBLIC_CLOUD_API_ORIGIN: "https://api.cohub.live",
  PUBLIC_CLOUD_GATEWAY_ORIGIN: "wss://gateway.cohub.live/ws",
  TURN_OBJECT_S3_ENDPOINT: "http://127.0.0.1:9000",
  TURN_OBJECT_S3_PUBLIC_ENDPOINT: "http://127.0.0.1:9000",
  TURN_OBJECT_S3_REGION: "us-east-1",
  TURN_OBJECT_S3_BUCKET: "cohub-sessions",
  TURN_OBJECT_S3_ACCESS_KEY_ID: "cohub-local",
  TURN_OBJECT_S3_SECRET_ACCESS_KEY: minioPassword,
  TURN_OBJECT_CDN_BASE_URL: "http://127.0.0.1:9000/cohub-sessions",
  PUBLIC_ASSET_OSS_ENDPOINT: "http://127.0.0.1:9000",
  PUBLIC_ASSET_OSS_PUBLIC_ENDPOINT: "http://127.0.0.1:9000",
  PUBLIC_ASSET_OSS_REGION: "us-east-1",
  PUBLIC_ASSET_OSS_BUCKET: "cohub-assets",
  PUBLIC_ASSET_OSS_ACCESS_KEY_ID: "cohub-local",
  PUBLIC_ASSET_OSS_SECRET_ACCESS_KEY: minioPassword,
  PUBLIC_ASSET_CDN_BASE_URL: "http://127.0.0.1:9000/cohub-assets",
  USER_UPLOAD_S3_ENDPOINT: "http://127.0.0.1:9000",
  USER_UPLOAD_S3_REGION: "us-east-1",
  USER_UPLOAD_S3_ACCESS_KEY_ID: "cohub-local",
  USER_UPLOAD_S3_SECRET_ACCESS_KEY: minioPassword,
  CHAT_ATTACHMENT_S3_BUCKET: "cohub-assets",
  CHAT_ATTACHMENT_PUBLIC_BASE_URL: "http://127.0.0.1:9000/cohub-assets",
  SPACE_UPLOAD_S3_BUCKET: "cohub-assets",
  APP_ASSET_CDN_BASE_URL: "http://127.0.0.1:9000/cohub-assets",
  CHECKPOINT_ASSET_OSS_ENDPOINT: "http://127.0.0.1:9000",
  CHECKPOINT_ASSET_OSS_PUBLIC_ENDPOINT: "http://127.0.0.1:9000",
  CHECKPOINT_ASSET_OSS_REGION: "us-east-1",
  CHECKPOINT_ASSET_OSS_BUCKET: "cohub-assets",
  CHECKPOINT_ASSET_OSS_ACCESS_KEY_ID: "cohub-local",
  CHECKPOINT_ASSET_OSS_SECRET_ACCESS_KEY: minioPassword,
  S3_FORCE_PATH_STYLE: "true",
  SPACE_STORAGE_ROOT: join(dataDir, "spaces"),
  WORKSPACE_ROOT: join(dataDir, "spaces"),
  SPACE_SYSTEM_ROOT: join(dataDir, "system"),
  CHECKPOINT_CACHE_ROOT: join(dataDir, "checkpoints"),
  SESSIONS_DIR: join(dataDir, "sessions"),
  PLATFORM_CONFIG_ROOT: join(dataDir, "configs"),
  LOCAL_GIT_ROOT: join(dataDir, "git"),
  SPACE_STORAGE_SUBPATH: "spaces",
  CHECKPOINT_CACHE_SUBPATH: "checkpoints",
  LOCAL_PI_PROVIDER: "openai",
  LOCAL_PI_MODEL: "gpt-5.1-codex-mini",
  LOCAL_PI_BASE_URL: "https://api.openai.com/v1",
  LOCAL_PI_API_KEY: "",
};

await mkdir(dirname(envFile), { recursive: true });
await Promise.all(
  [
    "postgres",
    "redis",
    "objects",
    "spaces",
    "system",
    "checkpoints",
    "sessions",
    "configs",
    "git",
  ].map((name) => mkdir(join(dataDir, name), { recursive: true })),
);
const contents = `${Object.entries(values)
  .map(([name, value]) => `${name}=${envValue(value)}`)
  .join("\n")}\n`;
await writeFile(envFile, contents, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});

console.log(`Created Local Mode environment: ${envFile}`);
console.log(`Local data will stay under: ${dataDir}`);
console.log("Run `pnpm local:up` to initialize and start the local node.");
