#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";
const arg = process.argv.indexOf("--session");
const path = arg < 0 ? null : process.argv[arg + 1];
const send = (value) => {
  const data = Buffer.from(`${JSON.stringify(value)}\n`);
  for (let offset = 0; offset < data.length; offset += 3) process.stdout.write(data.subarray(offset, offset + 3));
};
const model = { provider: "fixture", id: "test", name: "Test" };
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const input = JSON.parse(line);
  const respond = (data = {}) => send({ id: input.id, type: "response", success: true, data });
  if (input.type === "get_available_models") respond({ models: [model] });
  else if (input.type === "get_state") respond({ sessionId: path ? JSON.parse(readFileSync(path, "utf8").split("\n")[0]).id : "discovery", model, isStreaming: false });
  else if (input.type === "prompt") {
    respond();
    const data = readFileSync(path, "utf8");
    appendFileSync(path, `${JSON.stringify({ type: "message", id: "user-fixture", parentId: null, message: { role: "user", content: input.message } })}\n`);
    send({ type: "message_start", message: { role: "user" } });
    send({ type: "message_start", message: { role: "assistant" } });
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你好 " } });
    const answer = data.includes("historical") ? "history retained" : "new session";
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: answer } });
    const message = { role: "assistant", content: [{ type: "text", text: `你好 ${answer}` }], provider: "fixture", model: "test", stopReason: "stop" };
    appendFileSync(path, `${JSON.stringify({ type: "message", id: "assistant-fixture", parentId: "user-fixture", message })}\n`);
    send({ type: "turn_end", message, toolResults: [] });
    send({ type: "agent_end", willRetry: false });
    send({ type: "agent_settled" });
  } else respond();
}
