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
  artifact?: AppArtifactDescriptor;
} | {
  ok: false;
  status: number;
  message: string;
  code?: string;
};
