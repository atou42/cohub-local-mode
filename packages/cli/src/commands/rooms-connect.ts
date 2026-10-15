import type { Readable } from "node:stream";
import type { AppRoom } from "@neta-art/cohub";
import { createRealtimeClient } from "../client.js";

const MAX_LINE_BYTES = 20 * 1024;
const MAX_OUTPUT_BUFFER_BYTES = 1024 * 1024;

type Input =
  | { op: "publish" | "send"; type: string; data: unknown }
  | { op: "presence"; presence: Record<string, unknown> | null };

export function parseRoomInput(line: string): Input {
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error("Room input line is too large");
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Room input must be JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Room input must be an object");
  const input = value as Record<string, unknown>;
  if (input.op === "presence" && (input.presence === null || typeof input.presence === "object" && !Array.isArray(input.presence))) {
    return { op: "presence", presence: input.presence as Record<string, unknown> | null };
  }
  if ((input.op === "publish" || input.op === "send") && typeof input.type === "string" && "data" in input) {
    return { op: input.op, type: input.type, data: input.data };
  }
  throw new Error("Use {\"op\":\"publish|send\",\"type\":\"name\",\"data\":...} or {\"op\":\"presence\",\"presence\":...}");
}

export async function* readRoomLines(input: Readable, maxBytes = MAX_LINE_BYTES): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (;;) {
      const end = bytes.indexOf(10, start);
      const part = bytes.subarray(start, end < 0 ? bytes.length : end);
      if (pending.length + part.length > maxBytes) throw new Error("Room input line is too large");
      pending = pending.length ? Buffer.concat([pending, part]) : part;
      if (end < 0) break;
      yield pending.toString("utf8").replace(/\r$/, "");
      pending = Buffer.alloc(0);
      start = end + 1;
    }
  }
  if (pending.length) yield pending.toString("utf8");
}

export async function connectToRoom(roomId: string, options: { after?: string; input?: boolean; json: boolean }) {
  const after = options.after === undefined ? undefined : Number(options.after);
  if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new Error("--after must be a non-negative sequence number");
  const client = createRealtimeClient();
  let room: AppRoom<Record<string, unknown>> | null = null;
  let stopped = false;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    finish();
  };
  const write = (kind: string, value: Record<string, unknown>) => {
    if (stopped) return;
    if (process.stdout.writableLength > MAX_OUTPUT_BUFFER_BYTES) {
      process.stderr.write("Room output is too slow; disconnecting.\n");
      process.exitCode = 1;
      stop();
      return;
    }
    process.stdout.write(options.json ? `${JSON.stringify({ kind, ...value })}\n` : `${kind}: ${JSON.stringify(value)}\n`);
  };
  const onSignal = () => { stop(); void room?.disconnect().catch(() => undefined); void client.disconnect(); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let inputTask: Promise<void> | null = null;
  try {
    room = await client.rooms.connect(roomId, {
      after,
      onRoom: (active) => {
        room = active;
        if (stopped) { void active.disconnect(); return; }
        active.subscribeAll((event) => write("event", { event }));
        active.onMembersChanged((members) => write("members", { members }));
        active.onOutOfSync((from, to) => write("gap", { from, to }));
        active.onSendError((failure) => write("error", { message: failure.message }));
        active.onStateChange((state) => {
          write("state", { state });
          if (state === "closed" || state === "expired") stop();
        });
      },
    });
    if (!stopped) write("connected", { roomId, participantId: room.participantId, sequence: room.sequence });
    if (!stopped && options.input) {
      const active = room;
      inputTask = (async () => {
        let lineNumber = 0;
        for await (const line of readRoomLines(process.stdin)) {
          if (stopped) break;
          lineNumber++;
          if (!line.trim()) continue;
          try {
            const input = parseRoomInput(line);
            if (input.op === "presence") await active.setPresence(input.presence);
            else if (input.op === "send") active.send(input.type, input.data);
            else {
              const result = await active.publish(input.type, input.data);
              write("ack", { line: lineNumber, sequence: result.sequence, eventId: result.eventId });
            }
          } catch (cause) {
            write("input_error", { line: lineNumber, message: cause instanceof Error ? cause.message : String(cause) });
          }
        }
      })().catch((cause) => {
        write("input_error", { message: cause instanceof Error ? cause.message : String(cause) });
        process.exitCode = 1;
        stop();
      });
    }
    await done;
  } finally {
    if (options.input) process.stdin.destroy();
    await room?.disconnect().catch(() => undefined);
    await client.disconnect();
    await inputTask?.catch(() => undefined);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}
