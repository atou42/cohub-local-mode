import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	access,
	mkdir,
	readFile,
	rename,
	stat,
	writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { execFile, spawn, type ChildProcess } from "node:child_process";

const alphaOrigin = "https://dev-cohub.atou.cc";
const stateVersion = 2;
const keychainService = "Cohub Personal Node";
const cloudAuthKeychainService = "Cohub Personal Node Cloud Auth";
const cloudAuthKeychainAccount = "current";
const testPortOffset = Number(
	process.env.COHUB_PERSONAL_NODE_TEST_PORT_OFFSET ?? "0",
);
if (
	!Number.isInteger(testPortOffset) ||
	testPortOffset < 0 ||
	testPortOffset > 10_000
) {
	throw new Error(
		"COHUB_PERSONAL_NODE_TEST_PORT_OFFSET must be an integer from 0 to 10000",
	);
}
const localApiOrigin = `http://127.0.0.1:${8_787 + testPortOffset}`;
const localGatewayOrigin = `ws://127.0.0.1:${8_788 + testPortOffset}/ws`;

type StoredState = {
	version: typeof stateVersion;
	installationId: string;
	accountId: string;
	deviceId: string;
};

type RegistrationInput = {
	accessToken: string;
	refreshToken: string;
	accessTokenExpiresAt: number;
	scope: string;
};

type PublicStatus = {
	state:
		| "unregistered"
		| "initializing"
		| "local-runtime-unavailable"
		| "connecting"
		| "connected"
		| "error";
	deviceId: string | null;
	message: string | null;
};

let window: BrowserWindow | null = null;
let relayProcess: ChildProcess | null = null;
let relayStartPromise: Promise<void> | null = null;
let runtimeProcess: ChildProcess | null = null;
let lastRelayError: string | null = null;
let lastRuntimeError: string | null = null;
let resolveRuntimeReady: (() => void) | null = null;
let rejectRuntimeReady: ((error: Error) => void) | null = null;
let runtimeReady = new Promise<void>((resolve, reject) => {
	resolveRuntimeReady = resolve;
	rejectRuntimeReady = reject;
});
let currentStatus: PublicStatus = {
	state: "unregistered",
	deviceId: null,
	message: null,
};

function statePath() {
	return join(app.getPath("userData"), "personal-node.json");
}

function dataDir() {
	return join(app.getPath("userData"), "local-data");
}

async function sha256File(path: string) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function extractRuntime(archive: string, destination: string) {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			"/usr/bin/tar",
			["-xf", archive, "-C", destination],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr = `${stderr}${String(chunk)}`.slice(-16_384);
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else {
				reject(
					new Error(
						`Bundled runtime extraction failed (${signal ?? code ?? "unknown"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
					),
				);
			}
		});
	});
}

async function validateInstalledRuntime(directory: string) {
	for (const relative of [
		"manager.mjs",
		"node_modules/s3rver/package.json",
		"node_modules/postgres/package.json",
		"native/valkey-server",
		"native/cohub-sandboxd",
	]) {
		await access(join(directory, relative));
	}
}

async function resolveRuntimeScript() {
	if (!app.isPackaged) {
		return join(app.getAppPath(), "resources", "runtime", "manager.mjs");
	}
	const archive = join(process.resourcesPath, "runtime.tar");
	const manifestPath = join(process.resourcesPath, "runtime-manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
		schemaVersion?: unknown;
		sha256?: unknown;
		size?: unknown;
	};
	if (
		manifest.schemaVersion !== 1 ||
		typeof manifest.sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(manifest.sha256) ||
		typeof manifest.size !== "number" ||
		!Number.isSafeInteger(manifest.size) ||
		manifest.size <= 0
	) {
		throw new Error("Bundled runtime manifest is invalid");
	}
	const archiveStat = await stat(archive);
	if (archiveStat.size !== manifest.size) {
		throw new Error("Bundled runtime archive size does not match its manifest");
	}
	if ((await sha256File(archive)) !== manifest.sha256) {
		throw new Error("Bundled runtime archive checksum does not match its manifest");
	}

	const parent = join(app.getPath("userData"), "runtime");
	const installed = join(parent, manifest.sha256);
	let installedExists = true;
	try {
		await access(installed);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		installedExists = false;
	}
	if (installedExists) {
		let marker: { schemaVersion?: unknown; sha256?: unknown };
		try {
			marker = JSON.parse(
				await readFile(join(installed, ".cohub-runtime.json"), "utf8"),
			) as { schemaVersion?: unknown; sha256?: unknown };
		} catch (error) {
			throw new Error("Installed runtime marker cannot be read", {
				cause: error,
			});
		}
		if (marker.schemaVersion !== 1 || marker.sha256 !== manifest.sha256) {
			throw new Error("Installed runtime marker is invalid");
		}
		await validateInstalledRuntime(installed);
		return join(installed, "manager.mjs");
	}

	await mkdir(parent, { recursive: true });
	const temporary = `${installed}.${process.pid}.tmp`;
	await mkdir(temporary);
	await extractRuntime(archive, temporary);
	await validateInstalledRuntime(temporary);
	await writeFile(
		join(temporary, ".cohub-runtime.json"),
		`${JSON.stringify({ schemaVersion: 1, sha256: manifest.sha256 })}\n`,
		{ mode: 0o600, flag: "wx" },
	);
	await rename(temporary, installed);
	return join(installed, "manager.mjs");
}

function publishStatus(status: PublicStatus) {
	currentStatus = status;
	window?.webContents.send("personal-node:status", status);
}

function assertTrustedRenderer(event: Electron.IpcMainInvokeEvent) {
	if (!event.senderFrame || new URL(event.senderFrame.url).origin !== alphaOrigin) {
		throw new Error("Personal Node bridge rejected an untrusted page");
	}
}

async function readState(): Promise<StoredState | null> {
	try {
		const parsed = JSON.parse(await readFile(statePath(), "utf8")) as Partial<StoredState>;
		if (
			parsed.version !== stateVersion ||
			typeof parsed.installationId !== "string" ||
			typeof parsed.accountId !== "string" ||
			typeof parsed.deviceId !== "string"
		) {
			throw new Error("Personal Node state is invalid");
		}
		return parsed as StoredState;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function writeState(state: StoredState) {
	await mkdir(app.getPath("userData"), { recursive: true });
	const temporary = `${statePath()}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
	await rename(temporary, statePath());
}

function runSecurity(args: string[]) {
	return new Promise<string>((resolve, reject) => {
		execFile(
			"/usr/bin/security",
			args,
			{ encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 },
			(error, stdout, stderr) => {
				if (!error) {
					resolve(stdout.trim());
					return;
				}
				reject(
					new Error(
						`macOS Keychain request failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
						{ cause: error },
					),
				);
			},
		);
	});
}

async function readCredential(installationId: string) {
	const credential = await runSecurity([
		"find-generic-password",
		"-w",
		"-s",
		keychainService,
		"-a",
		installationId,
	]);
	if (!credential) {
		throw new Error("Personal Node credential is missing from macOS Keychain");
	}
	return credential;
}

async function writeCredential(installationId: string, credential: string) {
	await runSecurity([
		"add-generic-password",
		"-U",
		"-s",
		keychainService,
		"-a",
		installationId,
		"-w",
		credential,
	]);
}

function parseRegistrationInput(value: unknown): RegistrationInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Personal Node registration data is missing");
	}
	const record = value as Record<string, unknown>;
	const requiredString = (field: string) => {
		const candidate = record[field];
		if (
			typeof candidate !== "string" ||
			!candidate.trim() ||
			/[\r\n\0]/.test(candidate)
		) {
			throw new Error(`Personal Node registration has an invalid ${field}`);
		}
		return candidate.trim();
	};
	if (
		typeof record.accessTokenExpiresAt !== "number" ||
		!Number.isFinite(record.accessTokenExpiresAt) ||
		record.accessTokenExpiresAt <= Date.now()
	) {
		throw new Error(
			"Personal Node registration has an invalid accessTokenExpiresAt",
		);
	}
	return {
		accessToken: requiredString("accessToken"),
		refreshToken: requiredString("refreshToken"),
		accessTokenExpiresAt: record.accessTokenExpiresAt,
		scope: requiredString("scope"),
	};
}

async function writeCloudAuth(input: RegistrationInput) {
	await runSecurity([
		"add-generic-password",
		"-U",
		"-s",
		cloudAuthKeychainService,
		"-a",
		cloudAuthKeychainAccount,
		"-w",
		JSON.stringify({
			schemaVersion: 1,
			accessToken: input.accessToken,
			refreshToken: input.refreshToken,
			accessTokenExpiresAt: input.accessTokenExpiresAt,
			scope: input.scope,
			updatedAt: Date.now(),
		}),
	]);
}

async function requestJson(url: string, accessToken: string, init?: RequestInit) {
	const response = await fetch(url, {
		...init,
		headers: {
			...Object.fromEntries(new Headers(init?.headers).entries()),
			authorization: `Bearer ${accessToken}`,
			origin: alphaOrigin,
		},
	});
	const payload = await response.json().catch(() => null);
	if (!response.ok) {
		const message =
			payload && typeof payload.message === "string"
				? payload.message
				: `Personal Node registration returned HTTP ${response.status}`;
		throw new Error(message);
	}
	return payload as Record<string, unknown>;
}

async function registerDevice(input: RegistrationInput) {
	const existing = await readState();
	const credential = existing
		? await readCredential(existing.installationId)
		: randomBytes(32).toString("base64url");
	const installationId = existing?.installationId ?? randomUUID();
	const account = await requestJson(
		`${alphaOrigin}/api/alpha/v1/account`,
		input.accessToken,
	);
	if (typeof account.accountId !== "string" || !/^[0-9a-f]{64}$/.test(account.accountId)) {
		throw new Error("Personal Node account response is invalid");
	}
	if (existing && existing.accountId !== account.accountId) {
		throw new Error("This Personal Node is already registered to another account");
	}
	const registration = await requestJson(`${alphaOrigin}/api/alpha/v1/devices`, input.accessToken, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			installationId,
			displayName: hostname(),
			platform: "macos",
			appVersion: app.getVersion(),
			credentialHash: createHash("sha256").update(credential).digest("hex"),
		}),
	});
	const device = registration.device as { id?: unknown; status?: unknown } | undefined;
	if (typeof device?.id !== "string" || device.status !== "active") {
		throw new Error("Personal Node device response is invalid");
	}
	const state: StoredState = {
		version: stateVersion,
		installationId,
		accountId: account.accountId,
		deviceId: device.id,
	};
	await writeCredential(installationId, credential);
	await writeCloudAuth(input);
	await writeState(state);
	void runtimeReady
		.then(() => startRelay(state, credential))
		.catch((error) => {
			publishStatus({
				state: "error",
				deviceId: state.deviceId,
				message: error instanceof Error ? error.message : String(error),
			});
		});
	return { deviceId: state.deviceId, status: currentStatus.state };
}

async function startRuntime() {
	if (runtimeProcess && runtimeProcess.exitCode === null) return runtimeReady;
	publishStatus({ state: "initializing", deviceId: null, message: null });
	const runtimeScript = await resolveRuntimeScript();
	await access(runtimeScript);
	const finderPath = [
		join(process.env.HOME ?? "", ".local", "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
		process.env.PATH ?? "",
	].join(":");
	runtimeProcess = spawn(process.execPath, [runtimeScript], {
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
			NODE_ENV: "production",
			COHUB_LOCAL_DATA_DIR: dataDir(),
			COHUB_PERSONAL_NODE_AUTH_KEYCHAIN_SERVICE:
				cloudAuthKeychainService,
			COHUB_PERSONAL_NODE_AUTH_KEYCHAIN_ACCOUNT:
				cloudAuthKeychainAccount,
			COHUB_PERSONAL_NODE_AUTH_ORIGIN: alphaOrigin,
			PATH: finderPath,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	lastRuntimeError = null;
	let stdoutTail = "";
	let runtimeHasReady = false;
	runtimeProcess.stdout?.on("data", (chunk) => {
		if (runtimeHasReady) {
			console.log(String(chunk).trimEnd());
			return;
		}
		stdoutTail = `${stdoutTail}${String(chunk)}`.slice(-4_096);
		if (!stdoutTail.includes("[runtime] ready")) return;
		runtimeHasReady = true;
		stdoutTail = "";
		resolveRuntimeReady?.();
		resolveRuntimeReady = null;
		rejectRuntimeReady = null;
		void readState().then((state) => {
			if (!state) publishStatus({ state: "unregistered", deviceId: null, message: null });
		});
	});
	runtimeProcess.stderr?.on("data", (chunk) => {
		const message = String(chunk).trim();
		if (message) {
			console.error(message);
			if (!runtimeHasReady) {
				lastRuntimeError = message;
				publishStatus({ state: "initializing", deviceId: null, message });
			}
		}
	});
	runtimeProcess.once("exit", (code) => {
		runtimeProcess = null;
		const error = new Error(
			runtimeHasReady
				? `Local Cohub runtime stopped (${code ?? "signal"})`
				: lastRuntimeError ??
					`Local Cohub runtime stopped (${code ?? "signal"})`,
		);
		rejectRuntimeReady?.(error);
		publishStatus({ state: "error", deviceId: null, message: error.message });
	});
	return runtimeReady;
}

async function localApiReady() {
	try {
		const response = await fetch(`${localApiOrigin}/healthz`, {
			signal: AbortSignal.timeout(1_500),
		});
		return response.ok;
	} catch {
		return false;
	}
}

async function startRelay(state: StoredState, credential?: string) {
	if (relayProcess && relayProcess.exitCode === null) return;
	if (relayStartPromise) return relayStartPromise;
	relayStartPromise = startRelayOnce(state, credential).finally(() => {
		relayStartPromise = null;
	});
	return relayStartPromise;
}

async function startRelayOnce(state: StoredState, credential?: string) {
	if (!(await localApiReady())) {
		publishStatus({
			state: "local-runtime-unavailable",
			deviceId: state.deviceId,
			message: "The local Cohub runtime is not running",
		});
		return;
	}
	const relayScript = app.isPackaged
		? join(process.resourcesPath, "relay-node.mjs")
		: join(app.getAppPath(), "resources", "relay-node.mjs");
	await access(relayScript);
	const relayCredential = credential ?? await readCredential(state.installationId);
	publishStatus({ state: "connecting", deviceId: state.deviceId, message: null });
	relayProcess = spawn(process.execPath, [relayScript], {
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
			NODE_ENV: "production",
			COHUB_LOCAL_RELAY_URL: `${alphaOrigin.replace("https:", "wss:")}/api/alpha/v1/nodes/${state.accountId}/${state.deviceId}/connect`,
			COHUB_LOCAL_RELAY_NODE_ID: state.deviceId,
			COHUB_LOCAL_RELAY_NODE_TOKEN: relayCredential,
			COHUB_LOCAL_DATA_DIR: dataDir(),
			SPACE_STORAGE_ROOT: join(dataDir(), "spaces"),
			COHUB_LOCAL_RELAY_API_ORIGIN: localApiOrigin,
			COHUB_LOCAL_RELAY_GATEWAY_ORIGIN: localGatewayOrigin,
			PUBLIC_CLOUD_API_ORIGIN: "https://api.cohub.live",
			PUBLIC_CLOUD_GATEWAY_ORIGIN: "wss://gateway.cohub.live/ws",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	lastRelayError = null;
	relayProcess.stdout?.on("data", (chunk) => {
		if (String(chunk).includes("connected as")) {
			publishStatus({ state: "connected", deviceId: state.deviceId, message: null });
		}
	});
	relayProcess.stderr?.on("data", (chunk) => {
		const message = String(chunk).trim();
		if (message) {
			lastRelayError = message;
			console.error(message);
			publishStatus({ state: "error", deviceId: state.deviceId, message });
		}
	});
	relayProcess.once("exit", (code) => {
		relayProcess = null;
		publishStatus({
			state: "error",
			deviceId: state.deviceId,
			message:
				lastRelayError ?? `Personal Node relay stopped (${code ?? "signal"})`,
		});
	});
}

function createWindow() {
	window = new BrowserWindow({
		width: 1440,
		height: 940,
		minWidth: 960,
		minHeight: 640,
		title: "Cohub Personal Node",
		webPreferences: {
			preload: join(app.getAppPath(), "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		void shell.openExternal(url);
		return { action: "deny" };
	});
	window.webContents.on("will-navigate", (event, url) => {
		const origin = new URL(url).origin;
		if (origin !== alphaOrigin && origin !== "https://auth.neta.art") {
			event.preventDefault();
			void shell.openExternal(url);
		}
	});
	void window.loadURL(alphaOrigin);
}

ipcMain.handle("personal-node:register", async (event, input: unknown) => {
	assertTrustedRenderer(event);
	return registerDevice(parseRegistrationInput(input));
});

ipcMain.handle("personal-node:status", (event) => {
	assertTrustedRenderer(event);
	return currentStatus;
});

void app.whenReady().then(async () => {
	createWindow();
	let restored: StoredState | null = null;
	try {
		restored = await readState();
	} catch (error) {
		publishStatus({
			state: "error",
			deviceId: null,
			message: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	void startRuntime()
		.then(async () => {
			const registered = await readState();
			if (registered) await startRelay(registered);
		})
		.catch((error) => {
			publishStatus({
				state: "error",
				deviceId: restored?.deviceId ?? null,
				message: error instanceof Error ? error.message : String(error),
			});
		});
});

app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", () => {
	relayProcess?.kill("SIGTERM");
	runtimeProcess?.kill("SIGTERM");
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
