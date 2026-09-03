import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	access,
	appendFile,
	mkdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { app, Menu, nativeImage, shell, Tray } from "electron";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
	isTrustedLegacyRuntimeCommand,
	nextRuntimeRestart,
	runtimeRestartLimit,
	statusPresentation,
	type ConnectorStatus,
} from "./connector-core.js";

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
const localServicePorts = [
	54_329 + testPortOffset,
	6_380 + testPortOffset,
	9_000 + testPortOffset,
	8_787 + testPortOffset,
	8_788 + testPortOffset,
] as const;

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

type PublicStatus = ConnectorStatus;

let tray: Tray | null = null;
let relayProcess: ChildProcess | null = null;
let relayStartPromise: Promise<void> | null = null;
let runtimeProcess: ChildProcess | null = null;
let localRuntimeReady = false;
let relayConnected = false;
let lastRelayError: string | null = null;
let lastRuntimeError: string | null = null;
let runtimeRestartTimer: ReturnType<typeof setTimeout> | null = null;
let runtimeStableTimer: ReturnType<typeof setTimeout> | null = null;
let relayRestartTimer: ReturnType<typeof setTimeout> | null = null;
let statusHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let runtimeRecoveryAttempt = 0;
let relayRecoveryAttempt = 0;
let runtimeStartPromise: Promise<void> | null = null;
let signInPromise: Promise<void> | null = null;
let logWrite = Promise.resolve();
let statusReportWrite = Promise.resolve();
let registeredState: StoredState | null = null;
let registeredCredential: string | null = null;
let quitting = false;
let allowQuit = false;
let suppressRuntimeRecovery = false;
let currentStatus: PublicStatus = {
	state: "signed-out",
	deviceId: null,
	message: null,
};

function statePath() {
	return join(app.getPath("userData"), "personal-node.json");
}

function dataDir() {
	return join(app.getPath("userData"), "local-data");
}

function runtimeOwnerPath() {
	return join(dataDir(), "runtime-owner.json");
}

function connectorLogPath() {
	return join(dataDir(), "logs", "connector.log");
}

async function prepareDiagnostics() {
	await mkdir(join(dataDir(), "logs"), { recursive: true });
	try {
		const current = await stat(connectorLogPath());
		if (current.size <= 10 * 1024 * 1024) return;
		const previous = `${connectorLogPath()}.1`;
		await rm(previous, { force: true });
		await rename(connectorLogPath(), previous);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function logMessage(source: string, message: string) {
	const clean = message.trimEnd();
	if (!clean) return;
	const entry = `${new Date().toISOString()} [${source}] ${clean}\n`;
	logWrite = logWrite
		.then(async () => {
			await mkdir(join(dataDir(), "logs"), { recursive: true });
			await appendFile(connectorLogPath(), entry, { mode: 0o600 });
		})
		.catch((error) => {
			console.error("Failed to write Connector diagnostics", error);
		});
}

function truncateMenuText(value: string, maxLength = 100) {
	const line = value.replaceAll(/\s+/g, " ").trim();
	return line.length <= maxLength ? line : `${line.slice(0, maxLength - 1)}…`;
}

function publishConnectorError(error: unknown) {
	publishStatus({
		state: "error",
		deviceId: registeredState?.deviceId ?? null,
		message: error instanceof Error ? error.message : String(error),
	});
}

function trayIcon() {
	const path = app.isPackaged
		? join(process.resourcesPath, "icon.icns")
		: join(app.getAppPath(), "assets", "Cohub.icns");
	const icon = nativeImage.createFromPath(path).resize({ width: 18, height: 18 });
	icon.setTemplateImage(true);
	return icon;
}

function refreshTrayMenu() {
	if (!tray) return;
	const presentation = statusPresentation(currentStatus);
	tray.setTitle(
		presentation.connected
			? ""
			: ["initializing", "connecting", "recovering"].includes(currentStatus.state)
				? "…"
				: "!",
	);
	tray.setToolTip(`Cohub Connector · ${presentation.label}`);
	tray.setContextMenu(
		Menu.buildFromTemplate([
			{ label: presentation.label, enabled: false },
			...(presentation.detail
				? [{ label: truncateMenuText(presentation.detail), enabled: false }]
				: []),
			{ type: "separator" },
			{
				label: "Open Cohub",
				click: () => void shell.openExternal(alphaOrigin).catch(publishConnectorError),
			},
			...(currentStatus.state === "signed-out"
				? [
						{
							label: "Sign In",
							click: () => void beginConnectorSignIn(),
						},
					]
				: []),
			{
				label: "Reconnect",
				enabled: !quitting,
				click: () => void reconnectConnector().catch(publishConnectorError),
			},
			{
				label: "View Diagnostics",
				click: () => void showDiagnostics().catch(publishConnectorError),
			},
			{
				label: "Start at Login",
				type: "checkbox",
				checked: app.getLoginItemSettings().openAtLogin,
				click: (item) => {
					app.setLoginItemSettings({ openAtLogin: item.checked });
					refreshTrayMenu();
				},
			},
			{ type: "separator" },
			{
				label: "Quit Cohub Connector",
				click: () => void quitConnector(),
			},
		]),
	);
}

async function showDiagnostics() {
	await mkdir(join(dataDir(), "logs"), { recursive: true });
	try {
		await access(connectorLogPath());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await writeFile(connectorLogPath(), "", { mode: 0o600, flag: "wx" });
	}
	shell.showItemInFolder(connectorLogPath());
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
		"node_modules/@embedded-postgres/darwin-arm64/package.json",
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
	logMessage("status", JSON.stringify(status));
	refreshTrayMenu();
	queueRemoteStatus(status);
}

function remoteStatusMessage(message: string | null) {
	if (!message) return null;
	return message
		.replaceAll(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
		.replaceAll(/(api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
		.slice(-2_048);
}

function queueRemoteStatus(status: PublicStatus) {
	if (!registeredState || !registeredCredential) return;
	const state = registeredState;
	const credential = registeredCredential;
	const body = JSON.stringify({
		state: status.state,
		message: remoteStatusMessage(status.message),
		...(status.attempt === undefined ? {} : { attempt: status.attempt }),
		...(status.maxAttempts === undefined ? {} : { maxAttempts: status.maxAttempts }),
		appVersion: app.getVersion(),
	});
	statusReportWrite = statusReportWrite
		.then(async () => {
			const response = await fetch(
				`${alphaOrigin}/api/alpha/v1/nodes/${state.accountId}/${state.deviceId}/status`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${credential}`,
						"content-type": "application/json",
					},
					body,
					signal: AbortSignal.timeout(5_000),
				},
			);
			if (!response.ok) {
				throw new Error(`Connector status report returned HTTP ${response.status}`);
			}
		})
		.catch((error) => {
			logMessage("status-report-error", error instanceof Error ? error.message : String(error));
		});
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

function execFileText(program: string, args: string[]) {
	return new Promise<string>((resolve, reject) => {
		execFile(
			program,
			args,
			{ encoding: "utf8", timeout: 15_000, maxBuffer: 256 * 1024 },
			(error, stdout, stderr) => {
				if (!error) {
					resolve(stdout.trim());
					return;
				}
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					reject(error);
					return;
				}
				const exitCode = (error as NodeJS.ErrnoException & { code?: number }).code;
				if (exitCode === 1 && !stderr.trim()) {
					resolve("");
					return;
				}
				reject(new Error(`${program} failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`, { cause: error }));
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
	registeredState = state;
	registeredCredential = credential;
	if (!statusHeartbeatTimer) {
		statusHeartbeatTimer = setInterval(
			() => queueRemoteStatus(currentStatus),
			15_000,
		);
	}
	void ensureRuntimeAndRelay(state, credential);
	return { deviceId: state.deviceId, status: currentStatus.state };
}

function validString(value: unknown, field: string, maxLength = 16_384) {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > maxLength ||
		/[\r\n\0]/.test(value)
	) {
		throw new Error(`Personal Node authentication has an invalid ${field}`);
	}
	return value.trim();
}

function validPositiveNumber(value: unknown, field: string) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Personal Node authentication has an invalid ${field}`);
	}
	return value;
}

function delay(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function beginConnectorSignIn() {
	if (signInPromise) return signInPromise;
	signInPromise = (async () => {
		publishStatus({ state: "signed-out", deviceId: null, message: "Preparing sign-in" });
		const response = await fetch(`${alphaOrigin}/api/alpha/v1/auth/device`, {
			method: "POST",
			cache: "no-store",
		});
		if (!response.ok) {
			throw new Error(`Personal Node sign-in returned HTTP ${response.status}`);
		}
		const authorization = (await response.json()) as Record<string, unknown>;
		const deviceCode = validString(authorization.deviceCode, "deviceCode", 4_096);
		const userCode = validString(authorization.userCode, "userCode", 64);
		const verificationUriComplete = validString(
			authorization.verificationUriComplete,
			"verificationUriComplete",
			4_096,
		);
		if (new URL(verificationUriComplete).protocol !== "https:") {
			throw new Error("Personal Node sign-in URL must use HTTPS");
		}
		const expiresAt =
			Date.now() + validPositiveNumber(authorization.expiresInSeconds, "expiresInSeconds") * 1_000;
		let intervalMs =
			validPositiveNumber(authorization.intervalSeconds, "intervalSeconds") * 1_000;
		publishStatus({
			state: "signed-out",
			deviceId: null,
			message: `Complete sign-in using code ${userCode}`,
		});
		await shell.openExternal(verificationUriComplete);
		while (!quitting && Date.now() < expiresAt) {
			await delay(intervalMs);
			if (quitting) return;
			const tokenResponse = await fetch(`${alphaOrigin}/api/alpha/v1/auth/token`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ deviceCode }),
				cache: "no-store",
			});
			if (tokenResponse.status === 202) continue;
			if (tokenResponse.status === 429) {
				intervalMs += 5_000;
				continue;
			}
			if (!tokenResponse.ok) {
				const payload = (await tokenResponse.json().catch(() => null)) as {
					message?: unknown;
				} | null;
				throw new Error(
					typeof payload?.message === "string"
						? payload.message
						: `Personal Node sign-in returned HTTP ${tokenResponse.status}`,
				);
			}
			const token = (await tokenResponse.json()) as Record<string, unknown>;
			if (token.status !== "complete" || token.tokenType !== "Bearer") {
				throw new Error("Personal Node token response is invalid");
			}
			await registerDevice({
				accessToken: validString(token.accessToken, "accessToken"),
				refreshToken: validString(token.refreshToken, "refreshToken"),
				accessTokenExpiresAt:
					Date.now() + validPositiveNumber(token.expiresInSeconds, "expiresInSeconds") * 1_000,
				scope: validString(token.scope, "scope", 1_024),
			});
			await shell.openExternal(alphaOrigin);
			return;
		}
		if (!quitting) throw new Error("Personal Node sign-in expired");
	})()
		.catch((error) => {
			if (!quitting) {
				publishStatus({
					state: "error",
					deviceId: null,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		})
		.finally(() => {
			signInPromise = null;
		});
	return signInPromise;
}

type RuntimeOwner = {
	schemaVersion: 1;
	pid: number;
	startedAt: string;
};

async function readRuntimeOwner(): Promise<RuntimeOwner | null> {
	try {
		const owner = JSON.parse(await readFile(runtimeOwnerPath(), "utf8")) as Partial<RuntimeOwner>;
		if (
			owner.schemaVersion !== 1 ||
			typeof owner.pid !== "number" ||
			!Number.isInteger(owner.pid) ||
			owner.pid <= 1 ||
			typeof owner.startedAt !== "string"
		) {
			throw new Error("Personal Node runtime owner state is invalid");
		}
		return owner as RuntimeOwner;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function writeRuntimeOwner(pid: number) {
	await mkdir(dataDir(), { recursive: true });
	const temporary = `${runtimeOwnerPath()}.${process.pid}.tmp`;
	await writeFile(
		temporary,
		`${JSON.stringify({ schemaVersion: 1, pid, startedAt: new Date().toISOString() })}\n`,
		{ mode: 0o600, flag: "wx" },
	);
	await rename(temporary, runtimeOwnerPath());
}

function processGroupAlive(pid: number) {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		// A privileged sandbox descendant can briefly outlive the runtime manager.
		// EPERM still proves that the process group exists, so keep waiting for it.
		if (code === "EPERM") return true;
		throw error;
	}
}

async function terminateProcessGroup(pid: number) {
	if (!processGroupAlive(pid)) return;
	process.kill(-pid, "SIGTERM");
	const deadline = Date.now() + 5_000;
	while (processGroupAlive(pid) && Date.now() < deadline) await delay(100);
	if (processGroupAlive(pid)) process.kill(-pid, "SIGKILL");
}

async function clearRuntimeOwner(pid: number) {
	const owner = await readRuntimeOwner();
	if (owner?.pid === pid) await rm(runtimeOwnerPath(), { force: true });
}

async function stopOwnedRuntime() {
	const owner = await readRuntimeOwner();
	if (!owner) return;
	await terminateProcessGroup(owner.pid);
	await clearRuntimeOwner(owner.pid);
}

async function legacyListenerPids() {
	const pids = new Set<number>();
	for (const port of localServicePorts) {
		const output = await execFileText("/usr/sbin/lsof", [
			"-nP",
			`-iTCP:${port}`,
			"-sTCP:LISTEN",
			"-t",
		]);
		for (const value of output.split("\n")) {
			if (!value) continue;
			const pid = Number(value);
			if (!Number.isInteger(pid) || pid <= 1) {
				throw new Error(`Invalid listener PID reported for local port ${port}`);
			}
			pids.add(pid);
		}
	}
	return [...pids];
}

async function cleanupLegacyRuntime() {
	if (await readRuntimeOwner()) return;
	const pids = await legacyListenerPids();
	if (pids.length === 0) return;
	const trustedRoot = app.getPath("userData");
	for (const pid of pids) {
		const command = await execFileText("/bin/ps", ["-p", String(pid), "-o", "command="]);
		if (!isTrustedLegacyRuntimeCommand(command, trustedRoot)) {
			throw new Error(
				`Local service port is occupied by another process (${pid}: ${truncateMenuText(command)})`,
			);
		}
		logMessage("recovery", `Stopping stale Personal Node process ${pid}: ${command}`);
		try {
			process.kill(pid, "SIGTERM");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
	const deadline = Date.now() + 5_000;
	while ((await legacyListenerPids()).length > 0 && Date.now() < deadline) await delay(100);
	const remaining = await legacyListenerPids();
	for (const pid of remaining) {
		const command = await execFileText("/bin/ps", ["-p", String(pid), "-o", "command="]);
		if (!isTrustedLegacyRuntimeCommand(command, trustedRoot)) {
			throw new Error(`Local service port remained occupied by another process (${pid})`);
		}
		process.kill(pid, "SIGKILL");
	}
}

async function startRuntimeOnce() {
	if (await localApiReady()) {
		localRuntimeReady = true;
		return;
	}
	localRuntimeReady = false;
	await stopOwnedRuntime();
	await cleanupLegacyRuntime();
	publishStatus({
		state: runtimeRecoveryAttempt > 0 ? "recovering" : "initializing",
		deviceId: (await readState())?.deviceId ?? null,
		message: lastRuntimeError,
		...(runtimeRecoveryAttempt > 0
			? { attempt: runtimeRecoveryAttempt, maxAttempts: runtimeRestartLimit }
			: {}),
	});
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
	const child = spawn(process.execPath, [runtimeScript], {
		detached: true,
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
	if (!child.pid) throw new Error("Local Cohub runtime did not start");
	const childPid = child.pid;
	runtimeProcess = child;
	await writeRuntimeOwner(childPid);
	lastRuntimeError = null;
	let stdoutTail = "";
	let stderrTail = "";
	let runtimeHasReady = false;
	await new Promise<void>((resolvePromise, reject) => {
		const startupTimeout = setTimeout(() => {
			reject(new Error("Local Cohub runtime did not become ready within 120 seconds"));
			void terminateProcessGroup(childPid);
		}, 120_000);
		child.stdout?.on("data", (chunk) => {
			const message = String(chunk);
			logMessage("runtime", message);
			stdoutTail = `${stdoutTail}${message}`.slice(-8_192);
			if (runtimeHasReady || !stdoutTail.includes("[runtime] ready")) return;
			runtimeHasReady = true;
			clearTimeout(startupTimeout);
			resolvePromise();
		});
		child.stderr?.on("data", (chunk) => {
			const message = String(chunk);
			logMessage("runtime-error", message);
			stderrTail = `${stderrTail}${message}`.slice(-16_384);
			lastRuntimeError =
				message
					.trim()
					.split("\n")
					.filter(Boolean)
					.at(-1) ?? lastRuntimeError;
		});
		child.once("error", (error) => {
			clearTimeout(startupTimeout);
			if (!runtimeHasReady) reject(error);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(startupTimeout);
			const ownedByConnector = runtimeProcess === child;
			if (ownedByConnector) runtimeProcess = null;
			if (!processGroupAlive(childPid)) void clearRuntimeOwner(childPid);
			const failureLines = stderrTail.trim().split("\n").filter(Boolean);
			const detail =
				failureLines.findLast((line) => line.includes("[runtime]")) ||
				failureLines.at(-1) ||
				`Local Cohub runtime stopped (${signal ?? code ?? "unknown"})`;
			const error = new Error(detail);
			if (!runtimeHasReady) reject(error);
			else if (ownedByConnector && !quitting) void handleRuntimeFailure(error);
		});
	});
	if (runtimeStableTimer) clearTimeout(runtimeStableTimer);
	localRuntimeReady = true;
	if (relayConnected) {
		const state = await readState();
		publishStatus({ state: "connected", deviceId: state?.deviceId ?? null, message: null });
	}
	runtimeStableTimer = setTimeout(() => {
		runtimeRecoveryAttempt = 0;
	}, 60_000);
}

async function startRuntime() {
	if (await localApiReady()) {
		localRuntimeReady = true;
		return;
	}
	if (runtimeStartPromise) return runtimeStartPromise;
	runtimeStartPromise = startRuntimeOnce().finally(() => {
		runtimeStartPromise = null;
	});
	return runtimeStartPromise;
}

async function ensureRuntimeAndRelay(state: StoredState, credential?: string) {
	try {
		await startRelay(state, credential);
		await startRuntime();
		if (relayConnected) {
			publishStatus({ state: "connected", deviceId: state.deviceId, message: null });
		}
	} catch (error) {
		if (!quitting) await scheduleRuntimeRecovery(error);
	}
}

async function handleRuntimeFailure(error: Error) {
	localRuntimeReady = false;
	await scheduleRuntimeRecovery(error);
}

async function scheduleRuntimeRecovery(error: unknown) {
	if (quitting || suppressRuntimeRecovery || runtimeRestartTimer) return;
	lastRuntimeError = error instanceof Error ? error.message : String(error);
	localRuntimeReady = false;
	runtimeRecoveryAttempt += 1;
	const restart = nextRuntimeRestart(runtimeRecoveryAttempt);
	const state = await readState();
	if (!restart) {
		publishStatus({
			state: "error",
			deviceId: state?.deviceId ?? null,
			message: `${lastRuntimeError} Recovery stopped after ${runtimeRestartLimit} attempts.`,
		});
		return;
	}
	publishStatus({
		state: "recovering",
		deviceId: state?.deviceId ?? null,
		message: lastRuntimeError,
		attempt: restart.attempt,
		maxAttempts: runtimeRestartLimit,
	});
	runtimeRestartTimer = setTimeout(() => {
		runtimeRestartTimer = null;
		void readState()
			.then((registered) =>
				registered ? ensureRuntimeAndRelay(registered) : startRuntime(),
			)
			.catch((nextError) => scheduleRuntimeRecovery(nextError));
	}, restart.delayMs);
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
	const relayScript = app.isPackaged
		? join(process.resourcesPath, "relay-node.mjs")
		: join(app.getAppPath(), "resources", "relay-node.mjs");
	await access(relayScript);
	const relayCredential = credential ?? await readCredential(state.installationId);
	publishStatus({ state: "connecting", deviceId: state.deviceId, message: null });
	const child = spawn(process.execPath, [relayScript], {
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
	relayProcess = child;
	lastRelayError = null;
	child.stdout?.on("data", (chunk) => {
		const message = String(chunk);
		logMessage("relay", message);
		if (message.includes("connected as")) {
			relayConnected = true;
			relayRecoveryAttempt = 0;
			publishStatus(
				localRuntimeReady
					? { state: "connected", deviceId: state.deviceId, message: null }
					: {
							state: "initializing",
							deviceId: state.deviceId,
							message: "Cloud connection ready; starting local services",
						},
			);
		}
	});
	child.stderr?.on("data", (chunk) => {
		const message = String(chunk).trim();
		if (message) {
			lastRelayError = message;
			logMessage("relay-error", message);
		}
	});
	child.once("exit", (code) => {
		if (relayProcess !== child) return;
		relayProcess = null;
		relayConnected = false;
		if (!quitting) {
			void scheduleRelayRecovery(
				state,
				lastRelayError ?? `Personal Node relay stopped (${code ?? "signal"})`,
			);
		}
	});
}

function scheduleRelayRecovery(state: StoredState, message: string) {
	if (quitting || relayRestartTimer) return;
	relayRecoveryAttempt += 1;
	const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(relayRecoveryAttempt - 1, 5));
	publishStatus({
		state: "connecting",
		deviceId: state.deviceId,
		message: `${message} Reconnecting in ${Math.ceil(delayMs / 1_000)}s.`,
	});
	relayRestartTimer = setTimeout(() => {
		relayRestartTimer = null;
		void startRelay(state).catch((error) => {
			scheduleRelayRecovery(
				state,
				error instanceof Error ? error.message : String(error),
			);
		});
	}, delayMs);
}

async function stopRelay() {
	if (relayRestartTimer) {
		clearTimeout(relayRestartTimer);
		relayRestartTimer = null;
	}
	const child = relayProcess;
	relayProcess = null;
	relayConnected = false;
	if (!child || child.exitCode !== null) return;
	child.kill("SIGTERM");
	await new Promise<void>((resolve) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			resolve();
		}, 5_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolve();
		});
	});
}

async function stopRuntime() {
	if (runtimeRestartTimer) {
		clearTimeout(runtimeRestartTimer);
		runtimeRestartTimer = null;
	}
	if (runtimeStableTimer) {
		clearTimeout(runtimeStableTimer);
		runtimeStableTimer = null;
	}
	const pendingStart = runtimeStartPromise;
	runtimeProcess = null;
	localRuntimeReady = false;
	await stopOwnedRuntime();
	await pendingStart?.catch(() => undefined);
}

async function reconnectConnector() {
	if (quitting) return;
	suppressRuntimeRecovery = true;
	try {
		await stopRelay();
		await stopRuntime();
		runtimeRecoveryAttempt = 0;
		relayRecoveryAttempt = 0;
		lastRuntimeError = null;
		lastRelayError = null;
	} catch (error) {
		publishStatus({
			state: "error",
			deviceId: registeredState?.deviceId ?? null,
			message: error instanceof Error ? error.message : String(error),
		});
		return;
	} finally {
		suppressRuntimeRecovery = false;
	}
	const state = await readState();
	if (!state) await beginConnectorSignIn();
	else await ensureRuntimeAndRelay(state);
}

async function quitConnector() {
	if (quitting) return;
	quitting = true;
	if (statusHeartbeatTimer) {
		clearInterval(statusHeartbeatTimer);
		statusHeartbeatTimer = null;
	}
	const state = await readState().catch(() => null);
	publishStatus({ state: "stopped", deviceId: state?.deviceId ?? null, message: null });
	await stopRelay().catch((error) => logMessage("shutdown-error", String(error)));
	await statusReportWrite;
	await stopRuntime().catch((error) => logMessage("shutdown-error", String(error)));
	await logWrite;
	allowQuit = true;
	app.quit();
}

function createTray() {
	tray = new Tray(trayIcon());
	tray.on("click", () => tray?.popUpContextMenu());
	refreshTrayMenu();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
	app.quit();
} else {
	app.on("second-instance", () => tray?.popUpContextMenu());
	void app.whenReady().then(async () => {
		app.dock?.hide();
		createTray();
		try {
			await prepareDiagnostics();
		} catch (error) {
			publishStatus({
				state: "error",
				deviceId: null,
				message: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		let restored: StoredState | null = null;
		try {
			restored = await readState();
			if (restored) {
				registeredState = restored;
				registeredCredential = await readCredential(restored.installationId);
				statusHeartbeatTimer = setInterval(
					() => queueRemoteStatus(currentStatus),
					15_000,
				);
			}
			if (!restored && !app.getLoginItemSettings().openAtLogin) {
				app.setLoginItemSettings({ openAtLogin: true });
				refreshTrayMenu();
			}
		} catch (error) {
			publishStatus({
				state: "error",
				deviceId: null,
				message: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		if (restored) {
			void ensureRuntimeAndRelay(restored);
		} else {
			void startRuntime().catch((error) => scheduleRuntimeRecovery(error));
			if (process.env.COHUB_CONNECTOR_DISABLE_AUTO_SIGN_IN === "1") {
				publishStatus({ state: "signed-out", deviceId: null, message: null });
			} else void beginConnectorSignIn();
		}
	});
}

app.on("before-quit", (event) => {
	if (allowQuit || !hasSingleInstanceLock) return;
	event.preventDefault();
	void quitConnector();
});
