import type { RelayCommand } from "./protocol.ts";

const CHUNK_CHARS = 16 * 1024;
type BodyReference = { count: number; characters: number; sha256: string };
export type StoredCommand = RelayCommand & { bodyReferences?: { request: BodyReference; result?: BodyReference } };
type Storage = Pick<DurableObjectStorage, "get" | "put" | "delete">;
const keyFor = (id: string, part: string, index: number) => `command-body:${id}:${part}:${index}`;
const digest = async (body: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

function reference(value: BodyReference) {
	if (!value || !Number.isInteger(value.count) || value.count < 0 || value.count > 512 || !Number.isSafeInteger(value.characters) || value.characters < 0 || value.count !== Math.ceil(value.characters / CHUNK_CHARS) || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error("Stored command body reference is invalid");
	return value;
}

export async function deleteCommandBodies(storage: Storage, value: StoredCommand) {
	if (value.bodyReferences === undefined) return;
	for (const [part, ref] of Object.entries(value.bodyReferences)) {
		for (let index = 0; index < reference(ref).count; index++) await storage.delete(keyFor(value.id, part, index));
	}
}

// Call inside the same transaction as the command metadata and its indexes.
export async function storeCommandWithBodies(storage: Storage, key: string, command: RelayCommand) {
	const previous = await storage.get<StoredCommand>(key);
	if (previous) await deleteCommandBodies(storage, previous);
	const store = async (part: string, body: string): Promise<BodyReference> => {
		const count = Math.ceil(body.length / CHUNK_CHARS);
		if (count > 512) throw new Error("Command body exceeds the durable storage limit");
		for (let index = 0; index < count; index++) await storage.put(keyFor(command.id, part, index), body.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS));
		return { count, characters: body.length, sha256: await digest(body) };
	};
	const request = await store("request", command.request.body);
	const result = command.result ? await store("result", command.result.body) : undefined;
	const stored: StoredCommand = { ...command, request: { ...command.request, body: "" }, result: command.result ? { ...command.result, body: "" } : null, bodyReferences: { request, ...(result ? { result } : {}) } };
	await storage.put(key, stored);
	return { stored, previous };
}

export async function loadCommandWithBodies(storage: Storage, value: StoredCommand): Promise<RelayCommand> {
	if (value.bodyReferences === undefined) return value;
	const { bodyReferences, ...command } = value;
	const load = async (part: string, ref: BodyReference) => {
		reference(ref);
		let body = "";
		for (let index = 0; index < ref.count; index++) {
			const chunk = await storage.get<string>(keyFor(value.id, part, index));
			if (typeof chunk !== "string") throw new Error("Stored command body chunk is missing or corrupt");
			body += chunk;
		}
		if (body.length !== ref.characters || await digest(body) !== ref.sha256) throw new Error("Stored command body checksum does not match");
		return body;
	};
	if (!bodyReferences.request || Boolean(command.result) !== Boolean(bodyReferences.result)) throw new Error("Stored command body metadata is incomplete");
	return { ...command, request: { ...command.request, body: await load("request", bodyReferences.request) }, result: command.result ? { ...command.result, body: await load("result", bodyReferences.result!) } : null };
}
