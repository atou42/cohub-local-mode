import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class CommandJournalError extends Error {
  constructor(message) {
    super(message);
    this.name = "CommandJournalError";
  }
}

function fingerprint(command) {
  return createHash("sha256").update(JSON.stringify({
    request: {
      ...command.request,
      headers: Object.fromEntries(Object.entries(command.request.headers ?? {}).sort(([a], [b]) => a.localeCompare(b))),
    },
    attachments: (command.attachments ?? []).map(({ id, sha256, size, contentType }) => ({ id, sha256, size, contentType })),
  })).digest("hex");
}

function decode(row) {
  if (!row) return null;
  const command = JSON.parse(row.command);
  const outcome = row.outcome === null ? null : JSON.parse(row.outcome);
  const watch = row.watch === null ? null : JSON.parse(row.watch);
  if (!command || command.id !== row.command_id || command.idempotencyKey !== row.operation_id ||
      fingerprint(command) !== row.fingerprint || !Number.isInteger(row.attempt) || row.attempt < 1 ||
      !["prepared", "dispatched", "completed"].includes(row.phase) ||
      (row.phase === "completed") !== Boolean(outcome) ||
      (outcome && (!["result", "failed"].includes(outcome.type) || outcome.commandId !== command.id || outcome.attempt !== row.attempt)) ||
      (outcome?.type === "result" && (!outcome.result || !Number.isInteger(outcome.result.status) || typeof outcome.result.body !== "string")) ||
      (outcome?.type === "failed" && (typeof outcome.code !== "string" || typeof outcome.message !== "string")) ||
      (watch && (typeof watch.eventId !== "string" || typeof watch.spaceId !== "string" || typeof watch.sessionId !== "string" || typeof watch.turnId !== "string"))) {
    throw new CommandJournalError("Relay command journal contains an invalid record; it was not reset");
  }
  return { ...row, command, outcome, watch };
}

export class CommandJournal {
  constructor(dataDir, scope) {
    this.scope = scope;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const path = join(dataDir, "relay-commands.sqlite");
    let created = false;
    try {
      closeSync(openSync(path, "wx", 0o600));
      created = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (statSync(path).size === 0) throw new CommandJournalError("Relay command journal is empty or initialization is incomplete; it was not reset");
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
      if (created) {
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE commands (
            scope TEXT NOT NULL, operation_id TEXT NOT NULL, command_id TEXT NOT NULL,
            fingerprint TEXT NOT NULL, command TEXT NOT NULL, attempt INTEGER NOT NULL,
            phase TEXT NOT NULL, outcome TEXT, watch TEXT, acknowledged INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (scope, operation_id), UNIQUE (scope, command_id)
          );
          PRAGMA user_version=1;
          COMMIT;`);
      }
      if (this.db.prepare("PRAGMA user_version").get().user_version !== 1 ||
          this.db.prepare("PRAGMA quick_check").get().quick_check !== "ok") {
        throw new CommandJournalError("Relay command journal is invalid or incompatible; it was not reset");
      }
      this.pending();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  find(command) {
    if (typeof command.idempotencyKey !== "string" || !command.idempotencyKey) {
      throw new CommandJournalError("Relay command has no stable operation identity");
    }
    const row = decode(this.db.prepare("SELECT * FROM commands WHERE scope=? AND operation_id=?").get(this.scope, command.idempotencyKey));
    if (row && row.fingerprint !== fingerprint(command)) {
      throw new CommandJournalError("Relay operation identity is bound to a different request");
    }
    return row;
  }

  prepare(command, attempt) {
    const existing = this.find(command);
    if (existing) return existing;
    this.db.prepare(`INSERT INTO commands (scope, operation_id, command_id, fingerprint, command, attempt, phase)
      VALUES (?, ?, ?, ?, ?, ?, 'prepared')`).run(this.scope, command.idempotencyKey, command.id, fingerprint(command), JSON.stringify(command), attempt);
    return this.find(command);
  }

  dispatch(command) {
    const row = this.find(command);
    if (!row) throw new CommandJournalError("Relay command was not persisted before dispatch");
    if (command.request.method === "GET") return true;
    return this.db.prepare("UPDATE commands SET phase='dispatched' WHERE scope=? AND operation_id=? AND phase='prepared'")
      .run(this.scope, command.idempotencyKey).changes === 1;
  }

  complete(command, attempt, outcome, watch = null) {
    if (!this.find(command)) throw new CommandJournalError("Cannot persist an unrecorded relay result");
    this.db.prepare("UPDATE commands SET command_id=?, command=?, attempt=?, phase='completed', outcome=?, watch=?, acknowledged=0 WHERE scope=? AND operation_id=?")
      .run(command.id, JSON.stringify(command), attempt, JSON.stringify(outcome), JSON.stringify(watch, (_key, value) => value instanceof Map ? [...value] : value), this.scope, command.idempotencyKey);
  }

  acknowledge(commandId) {
    const row = decode(this.db.prepare("SELECT * FROM commands WHERE scope=? AND command_id=?").get(this.scope, commandId));
    if (!row) return;
    if (row.command.request.method === "GET") {
      this.db.prepare("DELETE FROM commands WHERE scope=? AND command_id=?").run(this.scope, commandId);
    } else {
      this.db.prepare("UPDATE commands SET acknowledged=1 WHERE scope=? AND command_id=?").run(this.scope, commandId);
    }
  }

  pending() {
    return this.db.prepare("SELECT * FROM commands WHERE scope=? AND acknowledged=0 ORDER BY rowid").all(this.scope).map(decode);
  }

  close() { this.db.close(); }
}
