import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CommandJournal } from "./command-journal.mjs";

const command = {
  id: "command-1", idempotencyKey: "operation-1", nodeId: "device-1", attachments: [],
  request: { method: "POST", path: "/api/spaces", headers: {}, body: '{"name":"test"}' },
};
const result = { type: "result", commandId: command.id, attempt: 1, result: { status: 201, headers: {}, body: '{"id":"space-1"}' } };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "cohub-command-journal-"));
  const journals = [];
  const open = (scope = "account-1/device-1") => {
    const journal = new CommandJournal(directory, scope);
    journals.push(journal);
    return journal;
  };
  t.after(async () => {
    for (const journal of journals) {
      try { journal.close(); } catch (error) { if (error.code !== "ERR_INVALID_STATE") throw error; }
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { open, directory };
}

test("dispatch is atomic across independent journal connections", async (t) => {
  const { open } = await fixture(t);
  const first = open();
  const second = open();
  first.prepare(command, 1);
  second.prepare(command, 2);
  assert.equal(first.dispatch(command), true);
  assert.equal(second.dispatch(command), false);
  assert.equal(second.find(command).phase, "dispatched");
});

test("results and operation identity survive ACK, reopening, and a different command ID", async (t) => {
  const { open } = await fixture(t);
  const first = open();
  first.prepare(command, 1);
  first.dispatch(command);
  first.complete(command, 1, result);
  first.acknowledge(command.id);
  assert.equal(first.pending().length, 0);
  first.close();
  const second = open();
  assert.deepEqual(second.find({ ...command, id: "redelivered-id" }).outcome, result);
  assert.throws(() => second.find({ ...command, request: { ...command.request, body: "different" } }), /different request/);
  assert.equal(open("account-2/device-1").find(command), null);
  assert.equal(open("account-1/device-2").pending().length, 0);
});

test("turn watches retain their event identity and attachment replacements on disk", async (t) => {
  const { open } = await fixture(t);
  const journal = open();
  const watch = { eventId: "event-1", spaceId: "space-1", sessionId: "session-1", turnId: "turn-1", responseReplacements: new Map([["a", "b"]]) };
  journal.prepare(command, 1);
  journal.complete(command, 1, result, watch);
  assert.deepEqual(journal.pending()[0].watch, { ...watch, responseReplacements: [["a", "b"]] });
});

test("acknowledged reads release payload storage without weakening write deduplication", async (t) => {
  const { open } = await fixture(t);
  const journal = open();
  const read = { ...command, request: { ...command.request, method: "GET", body: "" } };
  journal.prepare(read, 1);
  assert.equal(journal.dispatch(read), true);
  assert.equal(journal.dispatch(read), true);
  journal.complete(read, 1, result);
  journal.acknowledge(read.id);
  assert.equal(journal.find(read), null);
});

test("empty, corrupt, and invalid existing journals fail without replacing the evidence", async (t) => {
  const { open, directory } = await fixture(t);
  const path = join(directory, "relay-commands.sqlite");
  for (const content of ["", "not a database"]) {
    await writeFile(path, content);
    assert.throws(() => open());
    assert.equal(await readFile(path, "utf8"), content);
  }
  await rm(path);
  const journal = open();
  journal.prepare(command, 1);
  journal.close();
  const tampered = new DatabaseSync(path);
  tampered.prepare("UPDATE commands SET command=?").run("{}");
  tampered.close();
  const before = await readFile(path);
  assert.throws(() => open(), /invalid record/);
  assert.deepEqual(await readFile(path), before);
});
