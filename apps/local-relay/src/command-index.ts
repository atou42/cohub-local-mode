import { isTerminalCommandStatus } from "./lifecycle.ts";
import type { RelayCommand } from "./protocol.ts";

export const COMMAND_PENDING_PREFIX = "command-pending:";
export const COMMAND_ACTIVE_PREFIX = "command-active:";
export const COMMAND_TERMINAL_PREFIX = "command-terminal:";
export const COMMAND_INDEX_VERSION_KEY = "meta:command-index-version";
export const COMMAND_TERMINAL_COUNT_KEY = "meta:command-terminal-count";

type IndexStorage = Pick<DurableObjectStorage, "get" | "put" | "delete" | "list">;
export type CommandIndexEntry = Pick<RelayCommand, "id" | "sequence" | "status" | "attempt" | "leaseExpiresAt" | "completedAt"> & {
	request: Pick<RelayCommand["request"], "method">;
};

export function validateCommandIndexEntry(value: CommandIndexEntry): CommandIndexEntry {
	if (!value || typeof value.id !== "string" || !value.id || !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
		!["queued", "claimed", "running", "succeeded", "failed", "cancelled"].includes(value.status) ||
		!Number.isSafeInteger(value.attempt) || value.attempt < 0 ||
		!value.request || typeof value.request.method !== "string" || !value.request.method ||
		(value.leaseExpiresAt !== null && (typeof value.leaseExpiresAt !== "string" || !Number.isFinite(Date.parse(value.leaseExpiresAt)))) ||
		(value.completedAt !== null && (typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt))))) {
		throw new Error("Stored relay command index metadata is invalid");
	}
	return value;
}

export function commandKeyForEntry(command: CommandIndexEntry) {
	validateCommandIndexEntry(command);
	return `command:${String(command.sequence).padStart(20, "0")}:${command.id}`;
}

export async function terminalCommandCount(storage: Pick<IndexStorage, "get">) {
	const count = await storage.get<number>(COMMAND_TERMINAL_COUNT_KEY);
	if (!Number.isSafeInteger(count) || count === undefined || count < 0) throw new Error("Stored terminal command count is invalid");
	return count;
}

async function writeIndexEntries(storage: IndexStorage, key: string, command: CommandIndexEntry) {
	if (key !== commandKeyForEntry(command)) throw new Error("Stored relay command key does not match its identity");
	const suffix = key.slice("command:".length);
	const entry: CommandIndexEntry = {
		id: command.id, sequence: command.sequence, status: command.status, attempt: command.attempt,
		leaseExpiresAt: command.leaseExpiresAt, completedAt: command.completedAt, request: { method: command.request.method },
	};
	const pending = `${COMMAND_PENDING_PREFIX}${suffix}`;
	const active = `${COMMAND_ACTIVE_PREFIX}${suffix}`;
	const terminal = `${COMMAND_TERMINAL_PREFIX}${suffix}`;
	if (isTerminalCommandStatus(command.status)) {
		await storage.put(terminal, entry);
		await storage.delete([pending, active]);
	} else {
		await storage.put(pending, entry);
		await storage.delete(terminal);
		if (command.status === "claimed" || command.status === "running") await storage.put(active, entry);
		else await storage.delete(active);
	}
}

// Legacy rows remain authoritative. Publish the marker only after every index
// and its count have been written in the same transaction, without body reads.
export async function initializeCommandIndexes(storage: IndexStorage) {
	const version = await storage.get(COMMAND_INDEX_VERSION_KEY);
	if (version === 1) { await terminalCommandCount(storage); return; }
	if (version !== undefined) throw new Error("Stored relay command index version is invalid");
	if (await storage.get(COMMAND_TERMINAL_COUNT_KEY) !== undefined) throw new Error("Relay command indexes are incomplete");
	for (const prefix of [COMMAND_ACTIVE_PREFIX, COMMAND_PENDING_PREFIX, COMMAND_TERMINAL_PREFIX]) {
		if ((await storage.list({ prefix, limit: 1 })).size > 0) throw new Error("Relay command indexes exist without a version marker");
	}
	const commands = await storage.list<RelayCommand>({ prefix: "command:" });
	let terminalCount = 0;
	for (const [key, command] of commands) {
		await writeIndexEntries(storage, key, command);
		if (isTerminalCommandStatus(command.status)) terminalCount++;
	}
	await storage.put({ [COMMAND_TERMINAL_COUNT_KEY]: terminalCount, [COMMAND_INDEX_VERSION_KEY]: 1 });
}

export async function updateCommandIndexes(storage: IndexStorage, key: string, command: CommandIndexEntry, previous?: CommandIndexEntry) {
	if (previous !== undefined) validateCommandIndexEntry(previous);
	await writeIndexEntries(storage, key, command);
	const difference = Number(isTerminalCommandStatus(command.status)) - Number(previous !== undefined && isTerminalCommandStatus(previous.status));
	if (difference) {
		const count = await terminalCommandCount(storage);
		if (count + difference < 0) throw new Error("Stored terminal command count is inconsistent");
		await storage.put(COMMAND_TERMINAL_COUNT_KEY, count + difference);
	}
}

export async function removeTerminalCommandIndex(storage: IndexStorage, key: string, command: CommandIndexEntry) {
	if (!isTerminalCommandStatus(command.status) || key !== commandKeyForEntry(command)) throw new Error("Only terminal commands may be collected");
	const count = await terminalCommandCount(storage);
	if (count < 1) throw new Error("Stored terminal command count is inconsistent");
	await storage.delete(`${COMMAND_TERMINAL_PREFIX}${key.slice("command:".length)}`);
	await storage.put(COMMAND_TERMINAL_COUNT_KEY, count - 1);
}
