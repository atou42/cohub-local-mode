import { readFile } from "node:fs/promises";
import type { CreateSpaceDecisionInput, DecisionAnswer, DecisionStateImage, SpaceDecisionResult } from "@neta-art/cohub";
import type { Command } from "commander";
import { uploadChatImageAsset } from "../avatar.js";
import { createClient } from "../client.js";
import { collectOption, readPromptContent } from "../command-input.js";
import { error, handleHttp, json as outJson, jsonRequested, table } from "../output.js";
import { resolveSpace } from "../space.js";

type DecisionOptions = {
  questions?: string;
  input?: string;
  image?: string[];
  model?: string;
  provider?: string;
  json?: boolean;
};

const REMOTE_URL = /^https?:\/\//i;

async function readJsonObject(source: string, label: string): Promise<Record<string, unknown>> {
  const text = source.trim().startsWith("{")
    ? source
    : await readFile(source, "utf-8").catch(() => error(`Cannot read ${label}`, source));
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return error(`Invalid ${label}`, "Expected a JSON object or a path to a JSON file");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return error(`Invalid ${label}`, "Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

export function mergeDecisionState(state: unknown, text: string, images: DecisionStateImage[]): unknown {
  if (!text && images.length === 0) return state;
  if (state !== undefined && typeof state !== "string" && !Array.isArray(state)) {
    throw new Error("Cannot combine a JSON object state with text or --image; use a text/image array in --input instead.");
  }
  const parts = [
    ...(Array.isArray(state) ? state : typeof state === "string" ? [state] : []),
    ...(text ? [text] : []),
    ...images,
  ];
  return parts.length === 1 && typeof parts[0] === "string" ? parts[0] : parts;
}

function formatAnswer(answer: DecisionAnswer): string {
  if (answer.type === "noul") return (answer.noul ?? 0).toFixed(2);
  if (answer.type === "choice") return answer.choice ?? "";
  const top = Object.entries(answer.probabilities ?? {}).sort(([, a], [, b]) => b - a)[0]?.[0];
  const label = top === undefined ? undefined : answer.legend?.[top];
  return `${(answer.score ?? 0).toFixed(2)}${label ? ` ${label}` : ""}`;
}

function printResult(result: SpaceDecisionResult) {
  table(
    Object.entries(result.answers).map(([key, answer]) => ({
      question: key,
      type: answer.type,
      answer: formatAnswer(answer),
      confidence: answer.confidence,
    })),
    [
      { key: "question", label: "QUESTION" },
      { key: "type", label: "TYPE" },
      { key: "answer", label: "ANSWER" },
      { key: "confidence", label: "CONFIDENCE", format: (value) => (typeof value === "number" ? value.toFixed(2) : "") },
    ],
  );
  const cost = result.usage.cost?.total;
  process.stderr.write(`\n  ${result.provider}/${result.model}${typeof cost === "number" ? `  cost: $${cost}` : ""}\n`);
}

async function runDecisionCommand(command: Command, words: string[], opts: DecisionOptions) {
  const base = opts.input ? await readJsonObject(opts.input, "input") : {};
  const questions = opts.questions ? await readJsonObject(opts.questions, "questions") : base.questions;
  if (!questions) return error("Questions required", "Pass --questions or --input");

  const spaceId = await resolveSpace(command, { home: true });
  const client = createClient();
  try {
    const images = opts.image ?? [];
    const text = words.length > 0 || base.state === undefined
      ? await readPromptContent(words, { allowEmpty: images.length > 0 })
      : "";
    const imageParts = images.map((url) => ({ type: "image_url" as const, image_url: { url } }));
    const state = mergeDecisionState(base.state, text, imageParts);
    await Promise.all(imageParts.map(async (part) => {
      if (!REMOTE_URL.test(part.image_url.url)) {
        part.image_url.url = (await uploadChatImageAsset({ client, spaceId, path: part.image_url.url })).publicUrl;
      }
    }));

    const input = {
      ...base,
      provider: opts.provider ?? base.provider,
      model: opts.model ?? base.model,
      state,
      questions,
    } as CreateSpaceDecisionInput;
    const result = await client.space(spaceId).decision(input);
    if (jsonRequested(opts)) return outJson(result);
    printResult(result);
  } catch (e: unknown) {
    handleHttp(e);
  }
}

export function registerDecisionCommand(parent: Command): void {
  parent
    .command("decision [state...]")
    .description("Answer yes/no, choice and score questions about text or images")
    .option("-q, --questions <json|path>", "Questions as inline JSON or a JSON file")
    .option("--input <path>", "Full request JSON file (state, questions, model)")
    .option("--image <path-or-url>", "Attach an image to the state", collectOption, [])
    .option("-m, --model <model>", "Decision model ID")
    .option("-p, --provider <provider>", "Provider name")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  cohub decision "I was charged twice" -q '{"refund":{"type":"noul","instructions":"Refund?"}}'
  cat ticket.txt | cohub decision -q questions.json --json
  cohub decision "Duplicate charge?" --image receipt.png -q questions.json
  cohub decision --input request.json`)
    .action((words: string[], opts: DecisionOptions) => runDecisionCommand(parent, words, opts));
}
