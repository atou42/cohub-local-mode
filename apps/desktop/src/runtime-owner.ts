export type RuntimeProcess = { pid: number; processFingerprint: string };
export type RuntimeOwner = RuntimeProcess & {
	schemaVersion: 2 | 3;
	startedAt: string;
	members?: RuntimeProcess[];
};

function validProcess(value: unknown): value is RuntimeProcess {
	if (!value || typeof value !== "object") return false;
	const candidate = value as RuntimeProcess;
	return Number.isInteger(candidate.pid) && candidate.pid > 1 &&
		typeof candidate.processFingerprint === "string" && Boolean(candidate.processFingerprint.trim());
}

export function parseRuntimeOwner(value: unknown): RuntimeOwner {
	const owner = value as RuntimeOwner | null;
	if (!validProcess(owner) || !owner ||
		(owner.schemaVersion !== 2 && owner.schemaVersion !== 3) ||
		typeof owner.startedAt !== "string" || !Number.isFinite(Date.parse(owner.startedAt)) ||
		(owner.schemaVersion === 3 && (!Array.isArray(owner.members) ||
			!owner.members.every(validProcess) ||
			new Set(owner.members.map(({ pid }) => pid)).size !== owner.members.length))) {
		throw new Error("Personal Node runtime owner state is invalid");
	}
	return owner;
}

export function processGroupPids(output: string, groupId: number): number[] {
	const pids: number[] = [];
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
		if (!match) throw new Error("Cannot parse runtime process group membership");
		if (Number(match[2]) === groupId) pids.push(Number(match[1]));
	}
	return pids;
}

export function processFingerprints(output: string): RuntimeProcess[] {
	return output.split("\n").filter((line) => line.trim()).map((line) => {
		const match = /^\s*(\d+)\s+(.+)$/.exec(line);
		if (!match) throw new Error("Cannot parse runtime process identity");
		const entry = { pid: Number(match[1]), processFingerprint: match[2].trim() };
		if (!validProcess(entry)) throw new Error("Cannot parse runtime process identity");
		return entry;
	});
}

export function assertRuntimeGroupOwner(owner: RuntimeOwner, current: RuntimeProcess[]) {
	const recorded = new Map((owner.members ?? []).map((entry) => [entry.pid, entry.processFingerprint]));
	recorded.set(owner.pid, owner.processFingerprint);
	let matched = false;
	for (const entry of current) {
		const expected = recorded.get(entry.pid);
		if (expected === undefined) continue;
		if (expected !== entry.processFingerprint) {
			throw new Error("Recorded runtime no longer matches its owner; refusing to stop another process");
		}
		matched = true;
	}
	// A surviving recorded member ties this group to the original runtime even
	// after its leader exits. A port number or an unrecognised PID cannot do so.
	if (!matched) throw new Error("Runtime process group has no verified surviving owner; refusing to stop unowned processes");
}
