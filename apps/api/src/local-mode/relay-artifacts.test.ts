import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RelayArtifactProjectionError,
  rewriteRelayArtifactProjection,
} from "./relay-artifacts.js";

const relayUrl =
  "/relay/v1/nodes/mac-mini/attachments/512a0386-225a-49cb-80b0-5668d6bb0ae5/content";

test("rewrites exact markdown artifact targets across the persisted turn projection", () => {
  const result = rewriteRelayArtifactProjection(
    {
      assistantContent: [
        { type: "text", text: "[download](report.txt)" },
      ],
      assistantText: "[download](report.txt)",
      summary: { text: "[download](report.txt)", finishReason: "completed" },
    },
    [{ from: "report.txt", to: relayUrl }],
  );

  assert.equal(result.changed, true);
  assert.deepEqual(result.assistantContent, [
    { type: "text", text: `[download](${relayUrl})` },
  ]);
  assert.equal(result.assistantText, `[download](${relayUrl})`);
  assert.deepEqual(result.summary, {
    text: `[download](${relayUrl})`,
    finishReason: "completed",
  });
});

test("is idempotent but rejects mappings that are absent from the turn", () => {
  const alreadyProjected = rewriteRelayArtifactProjection(
    {
      assistantContent: null,
      assistantText: `[download](${relayUrl})`,
      summary: null,
    },
    [{ from: "report.txt", to: relayUrl }],
  );
  assert.equal(alreadyProjected.changed, false);

  assert.throws(
    () =>
      rewriteRelayArtifactProjection(
        {
          assistantContent: null,
          assistantText: "plain report.txt text",
          summary: null,
        },
        [{ from: "report.txt", to: relayUrl }],
      ),
    (error: unknown) =>
      error instanceof RelayArtifactProjectionError &&
      error.code === "artifact_target_missing",
  );
});

test("rejects relay destinations outside the private attachment route", () => {
  assert.throws(
    () =>
      rewriteRelayArtifactProjection(
        {
          assistantContent: null,
          assistantText: "[download](report.txt)",
          summary: null,
        },
        [{ from: "report.txt", to: "https://attacker.example/report.txt" }],
      ),
    (error: unknown) =>
      error instanceof RelayArtifactProjectionError &&
      error.code === "artifact_destination_invalid",
  );
});
