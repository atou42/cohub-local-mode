import assert from "node:assert/strict";

const { normalizeAssistantTurn } = await import("../assistant-message-normalizer.js");

const case1 = normalizeAssistantTurn(
  {
    content: [
      { type: "thinking", thinking: "need tool" },
      { type: "tool_result", tool_use_id: "tool-1", content: "README exists", is_error: false },
      { type: "text", text: "Done." },
    ],
  },
  [
    {
      toolCallId: "tool-1",
      toolName: "read",
      input: { path: "/workspace/README.md" },
      content: [{ type: "text", text: "README exists" }],
      isError: false,
    },
  ],
);

assert.deepEqual(
  case1.content.map((block) => block.type),
  ["thinking", "tool_use", "tool_result", "text"],
  "should inject tool_use before tool_result when SDK content lacks toolCall",
);
assert.equal(case1.toolCallRenderStates.length, 1);
assert.equal(case1.toolCallRenderStates[0]?.status, "done");
assert.equal(case1.thinking, "need tool");

const case2 = normalizeAssistantTurn(
  {
    content: [
      { type: "text", text: "Let me check." },
      { type: "toolCall", id: "tool-2", name: "bash", arguments: { command: "pwd" } },
      { type: "tool_result", tool_use_id: "tool-2", content: " /workspace\n", is_error: false },
    ],
  },
  [
    {
      toolCallId: "tool-2",
      toolName: "bash",
      input: { command: "pwd" },
      content: [{ type: "text", text: "/workspace" }],
      isError: false,
    },
  ],
);

assert.equal(case2.content.filter((block) => block.type === "tool_use").length, 1, "should dedupe tool_use");
assert.equal(case2.content.filter((block) => block.type === "tool_result").length, 1, "should dedupe tool_result");
assert.equal(case2.toolCallRenderStates[0]?.summary, "pwd");

const case3 = normalizeAssistantTurn(
  {
    content: [{ type: "text", text: "Working..." }],
  },
  [
    {
      toolCallId: "tool-3",
      toolName: "read",
      input: { path: "/workspace/package.json" },
      isError: false,
    },
  ],
);

assert.deepEqual(
  case3.content.map((block) => block.type),
  ["text", "tool_use"],
  "should append running tool_use even when no tool_result exists yet",
);
assert.equal(case3.toolCallRenderStates[0]?.status, "running");

// Case 4: tool_result with structured array content should not override
// the text extracted in round 1 from raw toolResults
const case4 = normalizeAssistantTurn(
  {
    content: [
      { type: "text", text: "Checking..." },
      { type: "toolCall", id: "tool-4", name: "bash", arguments: { command: "git log --oneline" } },
      { type: "tool_result", tool_use_id: "tool-4", content: [{ type: "text", text: "abc123 commit message" }], is_error: false },
      { type: "text", text: "Done." },
    ],
  },
  [
    {
      toolCallId: "tool-4",
      toolName: "bash",
      input: { command: "git log --oneline" },
      content: [{ type: "text", text: "abc123 commit message" }],
      isError: false,
    },
  ],
);

const tr4 = case4.content.find((b) => b.type === "tool_result") as { content: string } | undefined;
assert.equal(
  typeof tr4?.content,
  "string",
  "tool_result.content should be a string, not an array or JSON",
);
assert.ok(
  tr4?.content === "abc123 commit message",
  "tool_result.content should contain the extracted text, not be overwritten by the array",
);

// Case 5: tool_result with structured array + extra content blocks
const case5 = normalizeAssistantTurn(
  {
    content: [
      { type: "toolCall", id: "tool-5a", name: "read", arguments: { path: "/a" } },
      { type: "toolCall", id: "tool-5b", name: "read", arguments: { path: "/b" } },
      { type: "tool_result", tool_use_id: "tool-5a", content: [{ type: "text", text: "content A" }], is_error: false },
      { type: "tool_result", tool_use_id: "tool-5b", content: [{ type: "text", text: "content B" }], is_error: false },
    ],
  },
  [
    { toolCallId: "tool-5a", toolName: "read", input: { path: "/a" }, content: [{ type: "text", text: "content A" }], isError: false },
    { toolCallId: "tool-5b", toolName: "read", input: { path: "/b" }, content: [{ type: "text", text: "content B" }], isError: false },
  ],
);

const tr5a = case5.content.find((b) => (b as { tool_use_id?: string }).tool_use_id === "tool-5a") as { content: string } | undefined;
const tr5b = case5.content.find((b) => (b as { tool_use_id?: string }).tool_use_id === "tool-5b") as { content: string } | undefined;
assert.equal(tr5a?.content, "content A", "tool-5a result should be plain text");
assert.equal(tr5b?.content, "content B", "tool-5b result should be plain text");

// Case 6: partial tool call from an errored assistant should still be preserved
const case6 = normalizeAssistantTurn(
  {
    stopReason: "error",
    errorMessage: "terminated",
    content: [
      { type: "text", text: "Let me fix it:" },
      { type: "toolCall", id: "tool-6", name: "edit", arguments: { path: "/workspace/a.ts" } },
    ],
  },
  [],
);

assert.deepEqual(
  case6.content.map((block) => block.type),
  ["text", "tool_use"],
  "partial tool call should be preserved even without a matching tool execution",
);
const tu6 = case6.content.find((b) => b.type === "tool_use") as { id: string; name: string; input: Record<string, unknown> } | undefined;
assert.equal(tu6?.id, "tool-6");
assert.equal(tu6?.name, "edit");
assert.deepEqual(tu6?.input, { path: "/workspace/a.ts" });

// Case 7: runtime timeline notes must survive persistence normalization
const case7 = normalizeAssistantTurn(
  {
    content: [
      {
        type: "system_note",
        note_type: "info",
        text: "Codex connected",
        _meta: {
          runtimeEvent: {
            kind: "status",
            eventType: "runtime.connected",
            at: "2026-08-25T09:00:00.000Z",
          },
          streamIndex: 0,
        },
      },
    ],
  },
  [],
);

assert.deepEqual(case7.content, [
  {
    type: "system_note",
    note_type: "info",
    text: "Codex connected",
    _meta: {
      runtimeEvent: {
        kind: "status",
        eventType: "runtime.connected",
        at: "2026-08-25T09:00:00.000Z",
      },
      streamIndex: 0,
    },
  },
]);
