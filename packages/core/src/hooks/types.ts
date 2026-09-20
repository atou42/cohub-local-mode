import type { SpaceHookableEvent } from "@cohub/protocol";

export type SpaceHookPromptDefinition = {
  text: string;
  sessionId?: string | null;
  title?: string | null;
  intent?: "followup" | "steer" | null;
  accessMode?: "read_only" | "full_access" | null;
  model?: string | null;
  provider?: string | null;
  thinkingLevel?: string | null;
  labelRefs?: string[] | null;
};

export type SpaceHookLabelFilter = {
  any?: string[];
  all?: string[];
  none?: string[];
};

export type SpaceHookAction = "run" | "prompt" | "uses";

/** Published App Action reference: `username/spaceSlug/appSlug/action`. */
export type SpaceHookUsesDefinition = {
  username: string;
  spaceSlug: string;
  appSlug: string;
  action: string;
};

export type SpaceHookDefinition = {
  schema: "cohub.space-hook.v1";
  path: string;
  event: SpaceHookableEvent;
  /** FS path globs for `space.fs.changed`. */
  paths?: string[];
  /** FS path ignore globs for `space.fs.changed`. */
  ignore?: string[];
  kinds?: Array<"create" | "modify" | "delete" | "rename">;
  /** Session id allowlist for `session.turn.finalized`. Omit = all sessions. */
  sessionIds?: string[];
  /** Session id denylist for `session.turn.finalized`. */
  ignoreSessionIds?: string[];
  /** Turn `meta.source` allowlist for `session.turn.finalized`. Omit = all sources. */
  sources?: string[];
  /** Session label ref filters for `session.turn.finalized`. */
  labels?: SpaceHookLabelFilter;
  /** Optional shared secret for `webhook`; omit to accept any caller. */
  secret?: string;
  action: SpaceHookAction;
  run?: string;
  prompt?: SpaceHookPromptDefinition;
  uses?: SpaceHookUsesDefinition;
  /** JSON input passed on stdin to the `uses` App Action. */
  with?: unknown;
  /** User-declared env for both run and prompt. Cannot override system COHUB_* keys. */
  env?: Record<string, string> | null;
  timeoutSecs?: number;
};

export type SpaceHookRunResult = {
  path: string;
  status: "completed" | "failed" | "skipped";
  action?: SpaceHookAction;
  exitCode?: number | null;
  durationMs?: number;
  output?: string;
  truncated?: boolean;
  error?: string;
  reason?: string;
  sessionId?: string | null;
  turnId?: string | null;
  userMessageId?: string | null;
  taskRunId?: string | null;
};

export type SpaceHookTaskResult = {
  eventId: string;
  eventType: string;
  hooks: SpaceHookRunResult[];
  /** Number of parsed hook definitions considered for this event (cache or disk). */
  definitionsCount?: number;
  /** Number of definitions that matched the event (execution task only). */
  matchedCount?: number;
  /** Whether hook definitions came from Redis cache or a disk load. */
  cache?: "hit" | "miss";
  /** Present when the task exits before matching hooks. */
  skipped?: string;
};

/** Internal dispatch job result — never written to task_runs. */
export type SpaceHookDispatchResult = {
  eventId: string;
  eventType: string;
  spaceId: string;
  definitionsCount: number;
  matchedCount: number;
  cache: "hit" | "miss";
  skipped?:
    | "empty_definitions"
    | "no_match"
    | "missing_space_owner";
  taskRunId?: string;
};

export type CachedSpaceHooksConfig = {
  version: 1;
  spaceId: string;
  updatedAt: string;
  definitions: SpaceHookDefinition[];
};
