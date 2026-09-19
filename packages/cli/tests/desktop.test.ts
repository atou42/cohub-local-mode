import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { currentIdentityKey } from "../src/space.js";
import { Command } from "commander";
import { registerDesktop, registerLegacyUi, resolveOpenSurface, resolveOptionalSpaceId } from "../src/commands/desktop.js";

const temporaryRoots: string[] = [];

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function createProgram(): { desktop: Command; open: Command } {
  const program = new Command("cohub")
    .option("-s, --space <id>", "Target space ID")
    .helpOption("-h, --help", "Show help");
  registerDesktop(program);
  const desktop = program.commands.find((command) => command.name() === "desktop");
  assert.ok(desktop, "desktop command must be registered");
  const open = desktop.commands.find((command) => command.name() === "open");
  assert.ok(open, "desktop open must be registered");
  return { desktop, open };
}

/** `helpInformation()` omits addHelpText sections. */
function renderHelp(command: Command): string {
  let text = "";
  command.configureOutput({ writeOut: (chunk) => { text += chunk; } });
  command.outputHelp();
  return text;
}

test("desktop open uses the current directory binding without falling back to Home", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-desktop-binding-"));
  temporaryRoots.push(root);
  const bindingsPath = join(root, "runtime-spaces.json");
  const previousToken = process.env.COHUB_EXECUTION_TOKEN;
  const previousSpace = process.env.COHUB_SPACE_ID;
  process.env.COHUB_EXECUTION_TOKEN = jwt({ actorUserId: "user-alice" });
  delete process.env.COHUB_SPACE_ID;
  try {
    await writeFile(bindingsPath, `${JSON.stringify({
      version: 1,
      bindings: [{ root, key: currentIdentityKey(), spaceId: "space-runtime" }],
    })}\n`);
    const { open } = createProgram();
    assert.equal(await resolveOptionalSpaceId(open, { cwd: root, bindingsPath }), "space-runtime");
    await rm(bindingsPath);
    assert.equal(await resolveOptionalSpaceId(open, { cwd: root, bindingsPath }), undefined);
  } finally {
    if (previousToken === undefined) delete process.env.COHUB_EXECUTION_TOKEN;
    else process.env.COHUB_EXECUTION_TOKEN = previousToken;
    if (previousSpace === undefined) delete process.env.COHUB_SPACE_ID;
    else process.env.COHUB_SPACE_ID = previousSpace;
  }
});

test("opening and calling an app is one command", () => {
  const { desktop, open } = createProgram();
  assert.deepEqual(desktop.commands.map((command) => command.name()), ["open"]);
  assert.deepEqual(open.registeredArguments.map((arg) => arg.name()), ["app-or-file"]);
});

test("desktop open exposes call, targeting, and retry options", () => {
  const { open } = createProgram();
  const options = open.options.map((option) => option.long);
  for (const expected of [
    "--call",
    "--data",
    "--input",
    "--client",
    "--command-id",
    "--no-wait",
    "--timeout-ms",
    "--json",
    "--as",
  ]) {
    assert.ok(options.includes(expected), `missing option ${expected}`);
  }
});

test("desktop open help explains provenance-scoped targeting", () => {
  const help = renderHelp(createProgram().open);
  assert.match(help, /only the desktop that originated the current chat/);
  assert.match(help, /cohub desktop open app:\/\/alice\/studio\/launch/);
  assert.match(help, /--call board\.focus/);
});

test("the legacy ui preview alias stays registered", () => {
  const program = new Command("cohub");
  registerLegacyUi(program);
  const ui = program.commands.find((command) => command.name() === "ui");
  assert.ok(ui, "ui command must be registered");
  const preview = ui.commands.find((command) => command.name() === "preview");
  assert.ok(preview, "ui preview must be registered");
  assert.match(preview.description(), /Deprecated/);
});

test("the surface comes from --as, then from what the App declared at publish time", () => {
  // Declared overlay opens as an overlay without any flag.
  assert.equal(resolveOpenSurface(undefined, "overlay"), "overlay");
  // An explicit --as always wins over the declaration, in both directions.
  assert.equal(resolveOpenSurface("window", "overlay"), undefined);
  assert.equal(resolveOpenSurface("overlay", "window"), "overlay");
  assert.equal(resolveOpenSurface("overlay", undefined), "overlay");
  // `window` is the implicit default and stays off the wire.
  assert.equal(resolveOpenSurface(undefined, "window"), undefined);
  assert.equal(resolveOpenSurface(undefined, undefined), undefined);
  // Anything unknown from an older or newer App record is ignored.
  assert.equal(resolveOpenSurface(undefined, "popup"), undefined);
});
