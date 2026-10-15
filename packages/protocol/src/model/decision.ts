import type { Usage } from "../core/index.js";

export type DecisionQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type DecisionAnswer = {
  type: "noul" | "choice" | "score";
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
  legend?: Record<string, string>;
  probabilities?: Record<string, number>;
};

export type DecisionStateImage = {
  type: "image_url";
  image_url: { url: string } | string;
};

export type DecisionState =
  | string
  | Record<string, unknown>
  | Array<string | DecisionStateImage>;

export type CreateSpaceDecisionInput = {
  provider?: string | null;
  model?: string | null;
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
};

export type SpaceDecisionResult = {
  decisionId: string;
  provider: string;
  model: string;
  answers: Record<string, DecisionAnswer>;
  /** `cost.total` is the upstream-reported charge for this call. */
  usage: Usage;
};
