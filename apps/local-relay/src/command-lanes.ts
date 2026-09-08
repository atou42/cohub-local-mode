import type { RelayCommand } from "./protocol.ts";

export const MAX_READ_COMMANDS = 4;

export type CommandLane = "read" | "mutation";

type CommandForLane = Pick<RelayCommand, "status"> & {
	request: Pick<RelayCommand["request"], "method">;
};

export function getCommandLane(command: Pick<CommandForLane, "request">): CommandLane {
	return command.request.method === "GET" ? "read" : "mutation";
}

export function isReadCommand(command: Pick<CommandForLane, "request">) {
	return getCommandLane(command) === "read";
}

function isActiveCommand(command: CommandForLane) {
	return command.status === "claimed" || command.status === "running";
}

/**
 * Select queued commands for the node's two execution lanes.
 *
 * Reads may use four slots, while mutations always use one serial slot. The
 * selection is derived from durable command status so a repeated wake-up can
 * safely produce the same command frame until its claim is persisted.
 */
export function selectDispatchableCommands<T extends CommandForLane>(
	commands: readonly T[],
): T[] {
	let activeReads = 0;
	let activeMutation = false;
	for (const command of commands) {
		if (!isActiveCommand(command)) continue;
		if (isReadCommand(command)) activeReads += 1;
		else activeMutation = true;
	}

	let readSlots = Math.max(0, MAX_READ_COMMANDS - activeReads);
	let mutationSlot = activeMutation;
	const selected: T[] = [];
	for (const command of commands) {
		if (command.status !== "queued") continue;
		if (isReadCommand(command)) {
			if (readSlots === 0) continue;
			readSlots -= 1;
			selected.push(command);
			continue;
		}
		if (mutationSlot) continue;
		mutationSlot = true;
		selected.push(command);
	}
	return selected;
}
