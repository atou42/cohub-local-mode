import type { ContentBlock } from "../core/content.js";

export type SessionStreamEvent = {
  type: "stream_update";
  spaceId: string;
  sessionId: string;
  turnId?: string | null;
  seq: number;
  baseSeq: number;
  content: ContentBlock[];
  snapshotContent?: ContentBlock[];
  /** This frame authoritatively replaces all content blocks, including removals. */
  replaceContent?: boolean;
  messageId?: string | null;
  messageOrdinal?: number | null;
  sourceMessageId: string | null;
  timestamp: number;
  turnEnd?: boolean;
  anchorUserMessageId?: string | null;
};

export type SessionTurnLifecycleOutput = {
  type: "turn_lifecycle";
  spaceId: string;
  sessionId: string;
  turnId?: string | null;
  anchorUserMessageId?: string | null;
  phase: "llm_call_started";
  llmRound: number;
  provider?: string | null;
  model?: string | null;
  at: string;
  timestamp: number;
};

export type SessionStreamError = {
  type: "error";
  spaceId: string;
  sessionId: string | null;
  error: string;
};
