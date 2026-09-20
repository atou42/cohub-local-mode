import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isTerminalDesktopCommandStatus,
  isDesktopCallMethod,
  measureDesktopCommandPayload,
  parseDesktopCommand,
  parseDesktopCommandError,
  resolveOpenSurface,
  DESKTOP_COMMAND_DEFAULT_TIMEOUT_MS,
  DESKTOP_COMMAND_ERROR_CODE_MAX_LENGTH,
  DESKTOP_COMMAND_ERROR_MESSAGE_MAX_LENGTH,
  DESKTOP_COMMAND_LABEL_MAX_LENGTH,
  DESKTOP_COMMAND_LAUNCH_MAX_LENGTH,
  DESKTOP_COMMAND_MAX_BYTES,
  DESKTOP_COMMAND_MAX_TIMEOUT_MS,
  DESKTOP_COMMAND_PAYLOAD_MAX_BYTES,
  DESKTOP_COMMAND_PENDING_TTL_SECONDS,
  DESKTOP_COMMAND_SETTLEMENT_GRACE_SECONDS,
  DESKTOP_COMMAND_TERMINAL_TTL_SECONDS,
} from "./src/desktop-command.js";

const APP_ID = "123e4567-e89b-42d3-a456-426614174000";
const open = (target: unknown, call?: unknown) =>
  parseDesktopCommand({ type: "desktop.open", target, ...(call ? { call } : {}) });
const show = (preview: unknown, request?: unknown) =>
  parseDesktopCommand({ type: "preview.show", preview, ...(request ? { request } : {}) });

describe("parseDesktopCommand", () => {
  it("normalizes a full command, prefixing query and hash", () => {
    const parsed = open(
      { kind: "app", appId: APP_ID, label: " Launch ", launch: { search: "view=timeline", hash: "today" } },
      { method: "selection.get", input: { scope: "active" } },
    );
    assert.equal(parsed.error, null);
    assert.deepEqual(parsed.command, {
      type: "desktop.open",
      target: {
        kind: "app",
        appId: APP_ID,
        label: "Launch",
        launch: { search: "?view=timeline", hash: "#today" },
      },
      call: { method: "selection.get", input: { scope: "active" } },
    });
  });

  it("accepts a bare desktop.open", () => {
    assert.deepEqual(open({ kind: "app", appId: APP_ID }).command, {
      type: "desktop.open",
      target: { kind: "app", appId: APP_ID },
    });
  });

  it("accepts a relative file target without a call", () => {
    assert.deepEqual(open({ kind: "file", path: "boards/roadmap.board" }).command, {
      type: "desktop.open",
      target: { kind: "file", path: "boards/roadmap.board" },
    });
    assert.match(
      open({ kind: "file", path: "main.ts" }, { method: "selection.get" }).error ?? "",
      /only supported for app targets/,
    );
  });

  it("normalizes the legacy preview.show shape into the canonical command", () => {
    assert.deepEqual(
      show(
        { kind: "work", workId: APP_ID, label: "Launch", launch: { hash: "today" } },
        { method: "selection.get", input: { scope: "active" } },
      ).command,
      open(
        { kind: "app", appId: APP_ID, label: "Launch", launch: { hash: "today" } },
        { method: "selection.get", input: { scope: "active" } },
      ).command,
    );
    assert.deepEqual(show({ kind: "file", path: "src/main.ts" }).command, {
      type: "desktop.open",
      target: { kind: "file", path: "src/main.ts" },
    });
  });

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  for (const [expected, target, call] of [
    [/command\.target\.path is required/, { kind: "file" }],
    [/relative Space file path/, { kind: "file", path: "../etc/passwd" }],
    [/relative Space file path/, { kind: "file", path: "src\u0000main.ts" }],
    [/appId is required/, { kind: "app" }],
    // A slug or url must be resolved to an id before a command exists.
    [/must be an App id/, { kind: "app", appId: "alice/studio/launch" }],
    [/must be an App id/, { kind: "app", appId: "../../etc" }],
    [
      /label exceeds/,
      { kind: "app", appId: APP_ID, label: "x".repeat(DESKTOP_COMMAND_LABEL_MAX_LENGTH + 1) },
    ],
    [
      /launch\.search exceeds/,
      {
        kind: "app",
        appId: APP_ID,
        launch: { search: `?q=${"x".repeat(DESKTOP_COMMAND_LAUNCH_MAX_LENGTH)}` },
      },
    ],
    [/unsupported format/, { kind: "app", appId: APP_ID }, { method: "drop table; rm -rf" }],
    [
      /exceeds/,
      { kind: "app", appId: APP_ID },
      { method: "big", input: "x".repeat(DESKTOP_COMMAND_PAYLOAD_MAX_BYTES + 1) },
    ],
    [/JSON-serializable/, { kind: "app", appId: APP_ID }, { method: "cycle", input: cyclic }],
  ] as const) {
    it(`rejects input matching ${expected}`, () => {
      assert.match(open(target, call).error ?? "", expected);
    });
  }

  it("rejects an unknown command type", () => {
    assert.match(parseDesktopCommand({ type: "desktop.open.window" }).error ?? "", /command\.type/);
  });

  it("keeps a maximal legal command inside the envelope cap", () => {
    // Every field is individually legal; together they must still fit.
    const parsed = open(
      {
        kind: "app",
        appId: APP_ID,
        label: "x".repeat(DESKTOP_COMMAND_LABEL_MAX_LENGTH),
        launch: { search: `?a=${"x".repeat(DESKTOP_COMMAND_LAUNCH_MAX_LENGTH - 3)}` },
      },
      { method: "big", input: "y".repeat(DESKTOP_COMMAND_PAYLOAD_MAX_BYTES - 100) },
    );
    assert.equal(parsed.error, null);
    assert.ok((measureDesktopCommandPayload(parsed.command) ?? 0) <= DESKTOP_COMMAND_MAX_BYTES);
  });
});

describe("desktop command helpers", () => {
  it("keeps wait limits within the pending command lifetime", () => {
    assert.equal(DESKTOP_COMMAND_DEFAULT_TIMEOUT_MS, 10 * 60 * 1_000);
    assert.equal(DESKTOP_COMMAND_MAX_TIMEOUT_MS, 12 * 60 * 60 * 1_000);
    assert.equal(DESKTOP_COMMAND_SETTLEMENT_GRACE_SECONDS, 10 * 60);
    assert.equal(
      DESKTOP_COMMAND_PENDING_TTL_SECONDS,
      DESKTOP_COMMAND_MAX_TIMEOUT_MS / 1_000 + DESKTOP_COMMAND_SETTLEMENT_GRACE_SECONDS,
    );
    assert.equal(DESKTOP_COMMAND_TERMINAL_TTL_SECONDS, 30 * 60);
  });

  it("treats every status but pending as terminal", () => {
    assert.equal(isTerminalDesktopCommandStatus("pending"), false);
    assert.equal(isTerminalDesktopCommandStatus("applied"), true);
    assert.equal(isTerminalDesktopCommandStatus("timeout"), true);
  });

  it("caps a reported error and falls back to the status", () => {
    const capped = parseDesktopCommandError(
      { code: "c".repeat(500), message: "m".repeat(50_000) },
      "rejected",
    );
    assert.equal(capped?.code.length, DESKTOP_COMMAND_ERROR_CODE_MAX_LENGTH);
    assert.equal(capped?.message.length, DESKTOP_COMMAND_ERROR_MESSAGE_MAX_LENGTH);

    assert.deepEqual(parseDesktopCommandError({}, "rejected"), {
      code: "rejected",
      message: "Desktop command failed",
    });
    assert.equal(parseDesktopCommandError(null, "rejected"), null);
  });

  it("accepts namespaced method names only", () => {
    assert.equal(isDesktopCallMethod("selection.get"), true);
    assert.equal(isDesktopCallMethod("board:focus-node"), true);
    assert.equal(isDesktopCallMethod("1bad"), false);
    assert.equal(isDesktopCallMethod("has space"), false);
  });
});

describe("DesktopSurface field", () => {
  const APP_ID = "123e4567-e89b-42d3-a456-426614174000";

  it("parses overlay surface", () => {
    const { command } = parseDesktopCommand({
      type: "desktop.open",
      target: { kind: "app", appId: APP_ID, surface: "overlay" },
    });
    assert.equal(command?.target.kind === "app" && command.target.surface, "overlay");
  });

  it("omits surface when absent", () => {
    const { command } = parseDesktopCommand({
      type: "desktop.open",
      target: { kind: "app", appId: APP_ID },
    });
    assert.ok(command !== null);
    assert.equal(command.target.kind === "app" && command.target.surface, undefined);
  });

  it("ignores unrecognised surface values", () => {
    const { command } = parseDesktopCommand({
      type: "desktop.open",
      target: { kind: "app", appId: APP_ID, surface: "popup" },
    });
    assert.ok(command !== null);
    assert.equal(command.target.kind === "app" && command.target.surface, undefined);
  });

  it("accepts window as explicit value", () => {
    const { command } = parseDesktopCommand({
      type: "desktop.open",
      target: { kind: "app", appId: APP_ID, surface: "window" },
    });
    assert.ok(command !== null);
    // "window" is the default, stored as undefined to keep the payload compact.
    assert.equal(command.target.kind === "app" && command.target.surface, undefined);
  });
});

describe("resolveOpenSurface", () => {
  it("uses --as, then the App's published declaration", () => {
    // Declared overlay opens as an overlay without any flag.
    assert.equal(resolveOpenSurface(undefined, "overlay"), "overlay");
    // An explicit request always wins over the declaration, in both directions.
    assert.equal(resolveOpenSurface("window", "overlay"), undefined);
    assert.equal(resolveOpenSurface("overlay", "window"), "overlay");
    assert.equal(resolveOpenSurface("overlay", undefined), "overlay");
    // `window` is the implicit default and stays off the wire.
    assert.equal(resolveOpenSurface(undefined, "window"), undefined);
    assert.equal(resolveOpenSurface(undefined, undefined), undefined);
    // Anything unknown from an older or newer App record is ignored.
    assert.equal(resolveOpenSurface(undefined, "popup"), undefined);
  });
});
