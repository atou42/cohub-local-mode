import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const home = process.env.RUNTIME_TEST_DB_HOME;
if (!home) throw new Error("RUNTIME_TEST_DB_HOME must point to an isolated PGlite installation");
const { PGlite } = await import(`${home}/node_modules/@electric-sql/pglite/dist/index.js`);
const migrations = new URL("../drizzle/v2/", import.meta.url);

test("local migration history appends runtime storage without losing session identity or deduplication", async () => {
  const journal = JSON.parse(await readFile(new URL("meta/_journal.json", migrations), "utf8"));
  assert.deepEqual(journal.entries.slice(-3).map(({ idx, tag }) => ({ idx, tag })), [
    { idx: 65, tag: "0065_dusty_miss_america" },
    { idx: 66, tag: "0066_romantic_speedball" },
    { idx: 67, tag: "0067_runtime_harness_index" },
  ]);
  for (let i = 65; i < journal.entries.length; i++) {
    assert(journal.entries[i].when > journal.entries[i - 1].when);
  }
  const previous = JSON.parse(await readFile(new URL("meta/0066_snapshot.json", migrations), "utf8"));
  const next = JSON.parse(await readFile(new URL("meta/0067_snapshot.json", migrations), "utf8"));
  assert.equal(next.prevId, previous.id);
  assert.deepEqual(next.tables["v2.space_sessions"], previous.tables["v2.space_sessions"]);
  assert.deepEqual(next.tables["v2.session_turns"].indexes, previous.tables["v2.session_turns"].indexes);
  const database = new PGlite();
  try {
    await database.exec(`CREATE SCHEMA v2;
      CREATE TABLE v2.space_sessions (id text PRIMARY KEY, external_session_id text);
      CREATE TABLE v2.session_turns (id text PRIMARY KEY, session_id text, user_uuid text, execution_kind text, meta jsonb);
      INSERT INTO v2.space_sessions VALUES ('existing', 'native-session-kept');`);
    for (const tag of ["0065_dusty_miss_america", "0066_romantic_speedball"]) {
      await database.exec(await readFile(new URL(`${tag}.sql`, migrations), "utf8"));
    }
    await database.exec(`UPDATE v2.space_sessions SET agent_harness = 'codex';
      INSERT INTO v2.session_turns VALUES ('turn', 'existing', 'owner', 'agent', '{"clientMessageId":"original"}');`);
    const runtimeSql = await readFile(new URL("0067_runtime_harness_index.sql", migrations), "utf8");
    await database.exec(runtimeSql);
    await database.exec(runtimeSql);
    assert.deepEqual((await database.query("SELECT * FROM v2.space_sessions")).rows, [
      { id: "existing", external_session_id: "native-session-kept", agent_harness: "codex" },
    ]);
    assert.equal((await database.query("SELECT harness_index FROM v2.session_turns")).rows[0].harness_index, null);
    await assert.rejects(database.exec(`INSERT INTO v2.session_turns VALUES ('duplicate', 'existing', 'owner', 'agent', '{"clientMessageId":"original"}', NULL)`), /duplicate key/);
    assert.equal((await database.query("SELECT count(*)::int AS count FROM v2.session_turns")).rows[0].count, 1);
  } finally {
    await database.close();
  }
});
