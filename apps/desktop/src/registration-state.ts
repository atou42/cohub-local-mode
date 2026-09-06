import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

type RegistrationIdentity = { installationId: string; accountId: string };
type RegistrationOptions = {
	userDataPath: string;
	accountId: string;
	existing: RegistrationIdentity | null;
	readCredential: (installationId: string) => Promise<string>;
	writeCredential: (installationId: string, credential: string) => Promise<void>;
};

export async function prepareDeviceRegistration(options: RegistrationOptions) {
	let identity = options.existing;
	const pendingPath = join(options.userDataPath, "pending-registration.json");
	if (!identity) {
		let pending: string | null = null;
		try {
			pending = await readFile(pendingPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (pending !== null) {
			try {
				const parsed = JSON.parse(pending);
				if (parsed?.schemaVersion !== 1 || typeof parsed.installationId !== "string" ||
					!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(parsed.installationId) ||
					typeof parsed.accountId !== "string" || !/^[a-f0-9]{64}$/.test(parsed.accountId)) {
					throw new Error("Invalid identity fields");
				}
				identity = parsed;
			} catch (error) {
				throw new Error("Pending registration is invalid; existing state was preserved", { cause: error });
			}
		}
	}
	if (identity && identity.accountId !== options.accountId) {
		throw new Error("This Personal Node is already registered to another account");
	}
	const installationId = identity?.installationId ?? randomUUID();
	const credential = identity
		? await options.readCredential(installationId)
		: randomBytes(32).toString("base64url");
	if (!identity) {
		// Persist before the remote POST so a lost response cannot orphan the device.
		await options.writeCredential(installationId, credential);
		await mkdir(options.userDataPath, { recursive: true });
		const temporary = `${pendingPath}.${randomUUID()}.tmp`;
		await writeFile(temporary, JSON.stringify({ schemaVersion: 1, installationId, accountId: options.accountId }), { flag: "wx", mode: 0o600 });
		await rename(temporary, pendingPath);
	}
	return { installationId, credential };
}
