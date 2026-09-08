import { QueueEvents } from "bullmq";
import { COHUB_SYSTEM_QUEUE, createBullmqConnectionOptions, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import { getCurrentRequestId } from "@cohub/infra/tracing";
import { injectTrace } from "@cohub/infra/tracing/propagator";
import { config } from "./config.js";

import type { AppPublishExtractedPageMeta } from "@cohub/core/apps";
import type { AppArtifactDescriptor } from "@cohub/protocol";

export const APP_PUBLISH_ASSET_JOB = "app.publish_asset";

export type AppPublishAssetJobData = {
  spaceId: string;
  slug: string;
  targetType: "file" | "directory";
  targetRef: string;
  sourceType?: "workspace" | "upload";
  sourceRef?: string | null;
  sourceOwner?: string | null;
  requestId?: string | null;
  trace?: Record<string, unknown>;
};

export type { AppPublishExtractedPageMeta };

export type AppPublishAssetJobResult = {
  ok: true;
  assetKey: string;
  sizeBytes: number;
  fileCount?: number;
  extracted?: AppPublishExtractedPageMeta | null;
  /**
   * Absent from workers predating content-kind publishing. The API derives a
   * `web` descriptor in that case, so a rolling deploy in either order keeps
   * publishing rather than failing on a missing field.
   */
  artifact?: AppArtifactDescriptor;
} | {
  ok: false;
  status: number;
  message: string;
  code?: string;
};

const appPublishAssetQueue = createBullmqQueue<AppPublishAssetJobData, AppPublishAssetJobResult>(COHUB_SYSTEM_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-api-app-publish-asset",
});

const appPublishAssetQueueEvents = new QueueEvents(COHUB_SYSTEM_QUEUE, {
  connection: createBullmqConnectionOptions(config.bullmqRedisUrl),
});

export async function publishAppAssetInWorker(input: Omit<AppPublishAssetJobData, "requestId" | "trace">) {
  const job = await appPublishAssetQueue.add(APP_PUBLISH_ASSET_JOB, {
    ...input,
    requestId: getCurrentRequestId() ?? null,
    trace: injectTrace(),
  }, {
    jobId: `app-publish-asset-${input.spaceId}-${input.slug}-${Date.now()}`,
    attempts: 1,
    ...defaultJobRetention,
  });

  return job.waitUntilFinished(appPublishAssetQueueEvents, 30 * 60 * 1000) as Promise<AppPublishAssetJobResult>;
}
