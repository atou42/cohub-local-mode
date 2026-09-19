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

test("persists valid encoded workspace destinations", () => {
  for (const destination of [
    "/workspace/output/report.txt",
    "/workspace/output/report%20%28final%29.txt",
    "/workspace/%E6%8A%A5%E5%91%8A.txt",
    "/workspace/report%231%3F.txt",
    "/workspace/note%3A7",
    "/workspace/literal%252e.txt",
    "/workspace/trailing%20space%20",
    "/workspace/%252e%252e/secret",
    "/workspace/file%2500.txt",
  ]) {
    const projection = {
      assistantContent: [{ text: "[download](report.txt)" }],
      assistantText: "[download](report.txt)",
      summary: { text: "[download](report.txt)" },
    };
    const replacements = [{ from: "report.txt", to: destination }];
    const result = rewriteRelayArtifactProjection(projection, replacements);
    assert.equal(result.assistantText, `[download](${destination})`);
    assert.deepEqual(result.assistantContent, [{ text: `[download](${destination})` }]);
    assert.deepEqual(result.summary, { text: `[download](${destination})` });
    assert.equal(result.changed, true);
    assert.equal(rewriteRelayArtifactProjection(result, replacements).changed, false);
    assert.throws(() => rewriteRelayArtifactProjection({ ...projection, assistantContent: null, assistantText: "missing", summary: null }, replacements),
      (error: unknown) => error instanceof RelayArtifactProjectionError && error.code === "artifact_target_missing");
  }
});

test("rejects malformed and escaped workspace destinations", () => {
  for (const destination of [
    "/workspace", "/workspace/", "workspace/file.txt", "//workspace/file.txt",
    "/workspace//file.txt", "/workspace/file.txt/", "/workspace/./file.txt",
    "/workspace/../secret", "/workspace/a/../secret", "/workspace/%2e%2e/secret",
    "/workspace/%2E./secret", "/workspace/a%2f..%2fsecret",
    "/workspace/%5csecret", "/workspace/a\\secret", "/workspace/file?token=1", "/workspace/file#hash",
    "/workspace/file%3Ftoken=1", "/workspace/file\n.txt",
    "/workspace/file\u0000.txt", "/workspace/file%0a.txt", "/workspace/file%7F.txt",
    "/workspace/file%ZZ.txt", "/workspace/file%.txt",
    "/workspace/file name.txt", "/workspace/file(final).txt", "/workspace/file.txt:12",
  ]) {
    assert.throws(
      () => rewriteRelayArtifactProjection({ assistantContent: null, assistantText: "[download](report.txt)", summary: null }, [{ from: "report.txt", to: destination }]),
      (error: unknown) => error instanceof RelayArtifactProjectionError && error.code === "artifact_destination_invalid",
      destination,
    );
  }
});
