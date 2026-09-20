import type { BoardSnapshot } from "./board.js";

export type AppContentKind = "web" | "file" | "board";

/**
 * Provenance summary for a published app version. The session/turn identity is
 * included only when the caller may view the source session, so a viewer who
 * cannot read a session still learns nothing about it.
 */
export type AppVersionSource = {
  via?: string;
  sessionId?: string;
  turnId?: string;
  /** Turn sequence within `sessionId`, for deep links into a session. */
  turnSequence?: number;
  /** Present only when the caller holds `session.view` for the source session. */
  session?: { id: string; title: string | null } | null;
};

export type AppArtifactDownloadDescriptor = {
  artifactRootKey: string;
  manifestKey: string;
  manifestSha256: string;
};

export type AppArtifactDescriptor =
  | ((
      | {
          kind: "web";
          mimeType: "text/html";
          sizeBytes: number;
          fileCount: number;
        }
      | {
          kind: "file";
          name: string;
          mimeType: string | null;
          sizeBytes: number;
          sha256: string;
        }
    ) & {
      download?: AppArtifactDownloadDescriptor;
    })
  | {
      kind: "board";
      boardId: string;
      boardVersion: number;
      sizeBytes: number;
      fileCount: number;
    };

export type AppArtifactManifestFile = {
  /** Path below the immutable artifact's content root. */
  artifactPath: string;
  /** Safe relative path restored by download clients. */
  outputPath: string;
  mimeType: string | null;
  sizeBytes: number;
  sha256: string;
};

export type AppArtifactManifest = {
  kind: "cohub.work.artifact-manifest";
  version: 1;
  targetType: "file" | "directory";
  targetRef: string;
  entrypoint: string;
  fileCount: number;
  sizeBytes: number;
  files: AppArtifactManifestFile[];
};

export type AppBoardAsset = {
  sourcePath: string;
  status: "captured" | "missing" | "rejected";
  reason?: string;
  artifactPath?: string;
  mimeType?: string | null;
  sizeBytes?: number;
  sha256?: string;
};

export type AppBoardArtifactManifest = {
  kind: "cohub.work.board";
  version: 1;
  sourcePath: string;
  snapshot: BoardSnapshot;
  assets: AppBoardAsset[];
};
