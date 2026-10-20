import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { HttpError } from "@neta-art/cohub";
import { createRealtimeClient } from "../client.js";
import { readRoomLines } from "./rooms-connect.js";
import { ensureRtcBinary } from "./rooms-rtc-binary.js";

export type RtcOptions = {
  helper?: string;
  audio?: string;
  video?: string;
  audioFormat: "pcm" | "opus";
  videoFormat: "i420" | "vp8";
  size?: string;
  fps: string;
  rate: string;
  channels: string;
  output?: string;
  receiveFormat: "rtp" | "raw";
  receiveSize: string;
  maxBytes: string;
  participant?: string;
  channel?: string;
  delivery: "reliable" | "latest";
  dataInput?: string;
  json?: boolean;
};

type SignalRequest = { kind: "request"; id: number; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown };

export async function runRoomRtc(roomId: string, options: RtcOptions) {
  if (options.delivery !== "reliable" && options.delivery !== "latest") throw new Error("--delivery must be reliable or latest");
  if (options.dataInput && !options.channel) throw new Error("--data-input requires --channel");
  if ([options.audio, options.video, options.dataInput].filter((value) => value === "-").length > 1) throw new Error("Only one input can use stdin");
  const maxBytes = Number(options.maxBytes);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("--max-bytes must be a non-negative safe integer");
  const client = createRealtimeClient();
  const sessions = new Set<string>();
  const pending = new Set<Promise<void>>();
  let room: Awaited<ReturnType<typeof client.rooms.connect>> | undefined;
  let helper: ChildProcess | undefined;
  let control: Writable | undefined;
  let exit: Promise<void> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let failure: unknown;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    helper?.kill("SIGTERM");
    if (helper) killTimer = setTimeout(() => helper?.kill("SIGKILL"), 5_000);
  };
  const fail = (cause: unknown) => { failure ??= cause; stop(); };
  const send = (value: unknown) => {
    if (!control || control.destroyed || stopped) return;
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line) > 256 * 1024 || control.writableLength > 1024 * 1024) throw new Error("RTC control input is too slow or too large");
    control.write(line);
  };
  let previousMembers = "";
  const report = (value: unknown) => {
    const output = options.output === "-" ? process.stderr : process.stdout;
    if (output.writableLength > 1024 * 1024) throw new Error("RTC output is too slow");
    output.write(`${JSON.stringify(value)}\n`);
  };
  const release = async (sessionId: string) => {
    if (!sessions.has(sessionId)) return;
    await client.rooms.signalRtc(roomId, { method: "DELETE", path: `/${sessionId}` });
    sessions.delete(sessionId);
  };
  const request = async (message: SignalRequest) => {
    try {
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(message.method)) throw new Error("Invalid RTC signaling method");
      const opening = message.method === "POST" && message.path === "";
      const body = await client.rooms.signalRtc<{ sessionId?: string }>(roomId, {
        method: message.method,
        path: message.path,
        body: opening ? { ticket: "hosted", participantId: room?.participantId } : message.method === "GET" ? undefined : message.body,
      });
      if (opening && body.sessionId) sessions.add(body.sessionId);
      if (message.method === "GET" && room) {
        const snapshot = await client.rooms.get(roomId);
        send({ kind: "members", body: snapshot.members.map(({ participantId, publications }) => ({ participantId, publications })) });
        previousMembers = "";
      }
      send({ kind: "response", id: message.id, body });
    } catch (cause) {
      send({ kind: "response", id: message.id, error: cause instanceof Error ? cause.message : String(cause), code: cause instanceof HttpError ? cause.code : "RTC_FAILED" });
    }
  };
  const track = (task: Promise<void>) => {
    pending.add(task);
    void task.catch(fail).finally(() => pending.delete(task));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdout.on("error", fail);
  process.stderr.on("error", fail);
  try {
    const binary = await ensureRtcBinary(options.helper);
    if (stopped) return;
    room = await client.rooms.connect(roomId);
    if (stopped) return;
    room.onStateChange((state) => {
      try { report({ kind: "room", state }); } catch (cause) { fail(cause); }
      if (state === "closed" || state === "expired") stop();
    });
    helper = spawn(binary, [], { stdio: ["inherit", "inherit", "inherit", "pipe", "pipe"] });
    control = helper.stdio[3] as Writable;
    const events = helper.stdio[4] as Readable;
    control.on("error", fail);
    exit = new Promise<void>((resolve, reject) => {
      helper?.once("error", reject);
      helper?.once("close", (code, signal) => {
        if (killTimer) clearTimeout(killTimer);
        if (code === 0 || stopped && signal === "SIGTERM") resolve();
        else reject(new Error(`RTC helper exited with ${signal ?? code}`));
      });
    });
    void exit.catch(fail);
    send({ protocol: 1, ...options, maxBytes, participantId: room.participantId });
    const updateMembers = () => {
      const body = room?.members.map(({ participantId, publications }) => ({ participantId, publications }));
      const next = JSON.stringify(body);
      if (next === previousMembers) return;
      send({ kind: "members", body });
      previousMembers = next;
    };
    room.onMembersChanged(() => { try { updateMembers(); } catch (cause) { fail(cause); } });
    updateMembers();
    report({ kind: "connected", roomId, participantId: room.participantId });
    for await (const line of readRoomLines(events, 256 * 1024)) {
      const message = JSON.parse(line) as SignalRequest | { kind: "release"; sessionId: string };
      if (message.kind === "request") {
        if (pending.size >= 16) throw new Error("Too many pending RTC requests");
        track(request(message));
      } else if (message.kind === "release") {
        await release(message.sessionId);
      } else report(message);
    }
    await exit;
  } finally {
    stop();
    await exit?.catch((cause: unknown) => { failure ??= cause; });
    if (killTimer) clearTimeout(killTimer);
    await Promise.allSettled(pending);
    const results = await Promise.allSettled([...sessions].map(release));
    for (const result of results) if (result.status === "rejected") failure ??= result.reason;
    await room?.disconnect().catch((cause: unknown) => { failure ??= cause; });
    await client.disconnect().catch((cause: unknown) => { failure ??= cause; });
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.stdout.removeListener("error", fail);
    process.stderr.removeListener("error", fail);
  }
  if (failure) throw failure;
}
