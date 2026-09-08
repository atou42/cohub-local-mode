import { createHash, randomBytes, randomUUID } from "node:crypto";
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
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, net, shell, Tray } from "electron";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
	verifyRuntimeIdentity,
	personalNodeId,
	nextRuntimeRestart,
	runtimeRestartLimit,
	statusPresentation,
	type ConnectorStatus,
} from "./connector-core.js";
import { waitForRuntimeStartup } from "./runtime-startup.js";
import { installRuntime } from "./runtime-installation.js";
import { prepareDeviceRegistration } from "./registration-state.js";
import { createConnectorStatusReporter } from "./connector-status-reporter.js";
import { localAccountFromVerifiedRegistration } from "./local-account.js";
import { startupPageUrl } from "./startup-page.js";
import { parseRuntimeOwner, processGroupPids, processFingerprints, assertRuntimeGroupOwner, type RuntimeOwner } from "./runtime-owner.js";

const alphaOrigin = "https://dev2-cohub.atou.cc";
const stateVersion = 2;
const keychainService = "Cohub Dev2 Personal Node";
const cloudAuthKeychainService = "Cohub Dev2 Cloud Auth";
const cloudAuthKeychainAccount = "current";
const testPortOffset = Number(
	process.env.COHUB_PERSONAL_NODE_TEST_PORT_OFFSET ?? "4000",
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
const localWebOrigin = `http://127.0.0.1:${4_173 + testPortOffset}`;
const localServicePorts = [
	54_329 + testPortOffset,
	6_380 + testPortOffset,
	9_000 + testPortOffset,
	8_787 + testPortOffset,
	8_788 + testPortOffset,
	4_173 + testPortOffset,
] as const;

app.setName("Cohub Dev2");
app.setPath("userData", process.env.COHUB_DESKTOP_TEST_HOME ?? join(app.getPath("appData"), "Cohub Dev2"));

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
let relayStopPromise: Promise<void> | null = null;
let relayGeneration = 0;
let relayRuntimeId: string | null = null;
let relayNodeIdentity: string | null = null;
let runtimeProcess: ChildProcess | null = null;
let runtimeIdentity: { id: string; secret: string } | null = null;
let mainWindow: BrowserWindow | null = null;
let windowRuntimeId: string | null = null;
let windowNavigation: Promise<void> | null = null;
let lastRelayStatusAt = 0;
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
let runtimeStartAbort: AbortController | null = null;
let runtimeOwnerWrite = Promise.resolve();
let signInPromise: Promise<void> | null = null;
let registrationPromise: Promise<{ deviceId: string; status: PublicStatus["state"] }> | null = null;
let logWrite = Promise.resolve();
const statusReporter = createConnectorStatusReporter({
	onError: error => logMessage("status-report-error", error instanceof Error ? error.message : String(error)),
});
let registeredState: StoredState | null = null;
let registeredCredential: string | null = null;
let quitting = false;
let allowQuit = false;
let suppressRuntimeRecovery = false;
let connectorGeneration = 0;
let reconnectPromise: Promise<void> | null = null;
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
				click: () => void openLocalCohub().catch(publishConnectorError),
			},
			{
				label: "Open Remote Access",
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

async function openLocalCohub() {
	await showLocalWindow();
	try {
		await startRuntime();
	} catch (error) {
		await scheduleRuntimeRecovery(error);
		return;
	}
	await loadLocalWindow();
}

async function showLocalWindow() {
	if (quitting) return;
	if (mainWindow && !mainWindow.isDestroyed()) {
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.show();
		mainWindow.focus();
		return;
	}
	mainWindow = new BrowserWindow({
		width: 1280, height: 850, minWidth: 760, minHeight: 520,
		title: "Cohub Dev2", backgroundColor: "#F8F8FA",
		webPreferences: {
			preload: join(app.getAppPath(), "build", "preload.cjs"),
			nodeIntegration: false, contextIsolation: true, sandbox: true,
			partition: "persist:cohub-dev2",
		},
	});
	const contents = mainWindow.webContents;
	contents.session.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
		const headers = { ...details.requestHeaders };
		for (const key of Object.keys(headers)) {
			if (key.toLowerCase() === "x-cohub-desktop-secret") delete headers[key];
		}
		const url = new URL(details.url);
		if (runtimeIdentity && url.host === new URL(localWebOrigin).host && ["http:", "ws:"].includes(url.protocol)) {
			headers["X-Cohub-Desktop-Secret"] = runtimeIdentity.secret;
		}
		callback({ requestHeaders: headers });
	});
	contents.setWindowOpenHandler(({ url }) => {
		if (new URL(url).protocol === "https:") void shell.openExternal(url).catch(publishConnectorError);
		return { action: "deny" };
	});
	contents.on("will-navigate", (event, url) => {
		if (new URL(url).origin !== localWebOrigin) {
			event.preventDefault();
			if (new URL(url).protocol === "https:") void shell.openExternal(url).catch(publishConnectorError);
		}
	});
	const window = mainWindow;
	contents.on("did-finish-load", () => {
		if (window === mainWindow && !quitting) contents.send("cohub-desktop:status", currentStatus);
	});
	window.on("closed", () => {
		if (mainWindow !== window) return;
		mainWindow = null;
		windowRuntimeId = null;
		windowNavigation = null;
	});
	await showStartupPage();
}

async function showStartupPage(onlyWhileUnavailable = false) {
	const window = mainWindow;
	if (!window || window.isDestroyed() || quitting) return;
	windowRuntimeId = null;
	await windowNavigation?.catch(() => undefined);
	if (window !== mainWindow || window.isDestroyed() || quitting) return;
	if (onlyWhileUnavailable && localRuntimeReady) return;
	if (window.webContents.getURL() === startupPageUrl) return;
	const navigation = window.loadURL(startupPageUrl);
	windowNavigation = navigation;
	try {
		await navigation;
	} finally {
		if (windowNavigation === navigation) windowNavigation = null;
	}
}

async function loadLocalWindow() {
	const window = mainWindow;
	const identity = runtimeIdentity;
	if (!window || window.isDestroyed() || quitting || !localRuntimeReady || !identity) return;
	if (windowNavigation) {
		await windowNavigation;
		if (window !== mainWindow || identity !== runtimeIdentity || !localRuntimeReady || quitting) return;
	}
	if (windowRuntimeId === identity.id) return;
	const navigation = window.loadURL(`${localWebOrigin}/sessions`).then(() => {
		if (window === mainWindow && runtimeIdentity === identity && localRuntimeReady && !quitting) {
			windowRuntimeId = identity.id;
		}
	});
	windowNavigation = navigation;
	try {
		await navigation;
	} catch (error) {
		if (window === mainWindow && !window.isDestroyed() && !quitting) await window.loadURL(startupPageUrl);
		throw error;
	} finally {
		if (windowNavigation === navigation) windowNavigation = null;
	}
}

async function resolveRuntimeScript(signal: AbortSignal) {
	signal.throwIfAborted();
	if (!app.isPackaged) {
		return join(app.getAppPath(), "resources", "runtime", "manager.mjs");
	}
	return installRuntime(process.resourcesPath, app.getPath("userData"), signal, (message) => logMessage("runtime-install", message));
}

function publishStatus(status: PublicStatus) {
	if (quitting && status.state !== "stopped") return;
	const changed = JSON.stringify(currentStatus) !== JSON.stringify(status);
	currentStatus = status;
	if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("cohub-desktop:status", status);
	logMessage("status", JSON.stringify(status));
	refreshTrayMenu();
	if (changed) queueRemoteStatus(status);
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
	void statusReporter.publish({
		scope: `${state.accountId}:${state.deviceId}:${createHash("sha256").update(credential).digest("hex")}`,
		body,
		send: async () => {
			if (registeredState !== state || registeredCredential !== credential) return null;
			return cloudFetch(
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
		},
	});
}

function startStatusHeartbeat() {
	if (statusHeartbeatTimer) return;
	statusHeartbeatTimer = setInterval(() => {
		if (relayConnected && Date.now() - lastRelayStatusAt > 45_000) {
			relayConnected = false;
			publishStatus({ state: "connecting", deviceId: registeredState?.deviceId ?? null, message: "Remote connection stopped responding. Local Cohub is still available." });
		}
		queueRemoteStatus(currentStatus);
	}, 15_000);
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
			{ encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024,
				// Keychain belongs to the login user, not an overridden runtime HOME.
				env: { ...process.env, HOME: userInfo().homedir },
			},
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

async function writeCloudAuth(input: RegistrationInput, localIdentity: ReturnType<typeof localAccountFromVerifiedRegistration>) {
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
			localIdentity,
			accessToken: input.accessToken,
			refreshToken: input.refreshToken,
			accessTokenExpiresAt: input.accessTokenExpiresAt,
			scope: input.scope,
			updatedAt: Date.now(),
		}),
	]);
}

async function cloudFetch(url: string, init?: RequestInit) {
	if (new URL(url).origin !== alphaOrigin) throw new Error("Unexpected cloud request origin");
	try {
		return await net.fetch(url, {
			...init,
			credentials: "omit",
			redirect: "error",
			signal: init?.signal ?? AbortSignal.timeout(30_000),
		});
	} catch (error) {
		const code = (error as { cause?: { code?: string } }).cause?.code;
		throw new Error(`Request to ${new URL(url).pathname} failed: ${error instanceof Error ? error.message : String(error)}${code ? ` (${code})` : ""}`, { cause: error });
	}
}

async function requestJson(url: string, accessToken: string, init?: RequestInit) {
	const response = await cloudFetch(url, {
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
	if (quitting) throw new Error("Local Cohub is stopping");
	if (registrationPromise) throw new Error("Personal Node registration is already in progress");
	const pending = registerDeviceOnce(input).finally(() => {
		if (registrationPromise === pending) registrationPromise = null;
	});
	registrationPromise = pending;
	return pending;
}

async function prepareLocalAccountChange(existing: StoredState | null, next: StoredState) {
	if (!existing || (existing.accountId === next.accountId && existing.deviceId === next.deviceId)) return;
	connectorGeneration += 1;
	suppressRuntimeRecovery = true;
	localRuntimeReady = false;
	try {
		await showStartupPage(true);
		await stopRelay();
		await stopRuntime();
	} finally {
		suppressRuntimeRecovery = false;
	}
}

async function registerDeviceOnce(input: RegistrationInput) {
	const existing = await readState();
	const account = await requestJson(
		`${alphaOrigin}/api/alpha/v1/account`,
		input.accessToken,
	);
	if (typeof account.accountId !== "string" || !/^[0-9a-f]{64}$/.test(account.accountId)) {
		throw new Error("Personal Node account response is invalid");
	}
	const { credential, installationId } = await prepareDeviceRegistration({
		userDataPath: app.getPath("userData"), accountId: account.accountId,
		existing, readCredential, writeCredential,
	});
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
	const localIdentity = localAccountFromVerifiedRegistration({ accessToken: input.accessToken, account, deviceId: state.deviceId, issuer: "https://auth.neta.art/oidc" });
	if (quitting) throw new Error("Local Cohub is stopping");
	// Old-account relay requests must be gone before their local identity changes.
	await prepareLocalAccountChange(existing, state);
	if (quitting) throw new Error("Local Cohub is stopping");
	await writeCredential(installationId, credential);
	await writeCloudAuth(input, localIdentity);
	await writeState(state);
	registeredState = state;
	registeredCredential = credential;
	windowRuntimeId = null;
	startStatusHeartbeat();
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
		const response = await cloudFetch(`${alphaOrigin}/api/alpha/v1/auth/device`, {
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
			let tokenResponse: Response;
			try {
				tokenResponse = await cloudFetch(`${alphaOrigin}/api/alpha/v1/auth/token`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ deviceCode }),
					cache: "no-store",
				});
			} catch (error) {
				logMessage("sign-in-network-error", error instanceof Error ? error.message : String(error));
				if (!quitting) publishStatus({ state: "signed-out", deviceId: null, message: `Sign-in service unavailable. Retrying code ${userCode}` });
				continue;
			}
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
			await openLocalCohub();
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

async function readRuntimeOwner(): Promise<RuntimeOwner | null> {
	try {
		return parseRuntimeOwner(JSON.parse(await readFile(runtimeOwnerPath(), "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function readRuntimeGroup(pid: number) {
	const group = processGroupPids(await execFileText("/bin/ps", ["-axo", "pid=,pgid="]), pid);
	if (group.length === 0) return [];
	const members = processFingerprints(await execFileText("/bin/ps", ["-p", group.join(","), "-o", "pid=", "-o", "lstart=", "-o", "command="]));
	const remaining = new Set(processGroupPids(await execFileText("/bin/ps", ["-axo", "pid=,pgid="]), pid));
	return members.filter((entry) => remaining.has(entry.pid));
}

function writeRuntimeOwner(pid: number) {
	const writing = runtimeOwnerWrite.then(async () => {
		const members = await readRuntimeGroup(pid);
		const leader = members.find((entry) => entry.pid === pid);
		if (!leader) throw new Error("Cannot identify the started runtime process");
		await mkdir(dataDir(), { recursive: true });
		const temporary = `${runtimeOwnerPath()}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify({ schemaVersion: 3, ...leader, startedAt: new Date().toISOString(), members })}\n`, { mode: 0o600, flag: "wx" });
		await rename(temporary, runtimeOwnerPath());
	});
	// Callers receive the original failure; this barrier only serializes I/O.
	runtimeOwnerWrite = writing.then(() => undefined, () => undefined);
	return writing;
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
	try {
		// Let the runtime manager drain workers before it stops Redis and
		// Postgres. Signalling the whole group here tears every child down at
		// once and turns a normal Connector restart into queue/database errors.
		process.kill(pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		process.kill(-pid, "SIGTERM");
	}
	const deadline = Date.now() + 15_000;
	while (processGroupAlive(pid) && Date.now() < deadline) await delay(100);
	if (!processGroupAlive(pid)) return;
	process.kill(-pid, "SIGKILL");
	const killDeadline = Date.now() + 5_000;
	while (processGroupAlive(pid) && Date.now() < killDeadline) await delay(100);
	if (processGroupAlive(pid)) throw new Error("Owned runtime processes did not exit after SIGKILL");
}

async function clearRuntimeOwner(pid: number) {
	await runtimeOwnerWrite;
	const owner = await readRuntimeOwner();
	if (owner?.pid === pid) await rm(runtimeOwnerPath(), { force: true });
}

async function stopOwnedRuntime() {
	const owner = await readRuntimeOwner();
	if (!owner) return;
	if (processGroupAlive(owner.pid)) {
		const current = await readRuntimeGroup(owner.pid);
		if (current.length || processGroupAlive(owner.pid)) assertRuntimeGroupOwner(owner, current);
	}
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
	const pids = await legacyListenerPids();
	if (pids.length === 0) return;
	throw new Error(`Local service ports are occupied by unowned processes (${pids.join(", ")}); no process was stopped`);
}

async function startRuntimeOnce(signal: AbortSignal) {
	localRuntimeReady = false;
	await stopRelay();
	signal.throwIfAborted();
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
	const runtimeScript = await resolveRuntimeScript(signal);
	await access(runtimeScript);
	signal.throwIfAborted();
	const identity = { id: randomUUID(), secret: randomBytes(32).toString("base64url") };
	runtimeIdentity = identity;
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
			COHUB_PERSONAL_NODE_TEST_PORT_OFFSET: String(testPortOffset),
			COHUB_DESKTOP_INSTANCE_ID: identity.id,
			COHUB_DESKTOP_INSTANCE_SECRET: identity.secret,
			COHUB_PERSONAL_NODE_AUTH_KEYCHAIN_SERVICE:
				cloudAuthKeychainService,
			COHUB_PERSONAL_NODE_AUTH_KEYCHAIN_ACCOUNT:
				cloudAuthKeychainAccount,
			COHUB_PERSONAL_NODE_AUTH_ORIGIN: alphaOrigin,
			PATH: finderPath,
		},
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	if (!child.pid) {
		child.once("error", (error) => logMessage("runtime-error", error.message));
		throw new Error("Local Cohub runtime did not start");
	}
	const childPid = child.pid;
	runtimeProcess = child;
	lastRuntimeError = null;
	let stderrTail = "";
	let runtimeHasReady = false;
	child.on("message", (message: unknown) => {
		if (message && typeof message === "object" && Reflect.get(message, "type") === "runtime-progress" && Reflect.get(message, "instanceId") === identity.id && typeof Reflect.get(message, "stage") === "string" && runtimeProcess === child && !runtimeHasReady && !signal.aborted && !quitting) {
			publishStatus({ state: runtimeRecoveryAttempt > 0 ? "recovering" : "initializing", deviceId: currentStatus.deviceId, message: `Starting ${Reflect.get(message, "stage")}` });
		}
	});
	child.stdout?.on("data", (chunk) => {
		const message = String(chunk);
		logMessage("runtime", message);
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
	child.on("error", (error) => {
		logMessage("runtime-error", error.message);
		lastRuntimeError = error.message;
	});
	child.once("exit", (code, signal) => {
		const ownedByConnector = runtimeProcess === child;
		if (ownedByConnector) runtimeProcess = null;
		const failureLines = stderrTail.trim().split("\n").filter(Boolean);
		const detail =
			failureLines.findLast((line) => line.includes("[runtime]")) ||
			failureLines.at(-1) ||
			`Local Cohub runtime stopped (${signal ?? code ?? "unknown"})`;
		const error = new Error(detail);
		if (!runtimeHasReady) return;
		void (async () => {
			try {
				if (!processGroupAlive(childPid)) await clearRuntimeOwner(childPid);
			} catch (cleanupError) {
				const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
				lastRuntimeError = message;
				logMessage("runtime-cleanup-error", message);
			}
		})();
		if (ownedByConnector && !quitting) void handleRuntimeFailure(error);
	});
	await waitForRuntimeStartup({
		child,
		signal,
		instanceId: identity.id,
		prepare: async () => {
			await writeRuntimeOwner(childPid);
			signal.throwIfAborted();
		},
		verifyReady: async () => {
			// Persist the running services before readiness can be advertised.
			await writeRuntimeOwner(childPid);
			return localApiReady(identity, child);
		},
		isCurrent: () => runtimeProcess === child && runtimeIdentity === identity,
		onReady: () => {
			runtimeHasReady = true;
		},
		cleanup: async () => {
			await terminateProcessGroup(childPid);
			await clearRuntimeOwner(childPid);
			if (runtimeProcess === child) runtimeProcess = null;
		},
		describeExit: (code, signal) => {
			const failureLines = stderrTail.trim().split("\n").filter(Boolean);
			const detail =
				failureLines.findLast((line) => line.includes("[runtime]")) ||
				failureLines.at(-1) ||
				`Local Cohub runtime stopped (${signal ?? code ?? "unknown"})`;
			return new Error(detail);
		},
	});
	if (runtimeStableTimer) clearTimeout(runtimeStableTimer);
	localRuntimeReady = true;
	void loadLocalWindow().catch(publishConnectorError);
	if (relayConnected) {
		const state = await readState();
		publishStatus({ state: "connected", deviceId: state?.deviceId ?? null, message: null });
	}
	runtimeStableTimer = setTimeout(() => {
		runtimeRecoveryAttempt = 0;
	}, 60_000);
}

async function startRuntime() {
	if (registrationPromise) await registrationPromise;
	if (quitting) throw new Error("Local Cohub is stopping");
	if (localRuntimeReady && await localApiReady()) {
		return;
	}
	if (quitting) throw new Error("Local Cohub is stopping");
	if (runtimeStartPromise) return runtimeStartPromise;
	const controller = new AbortController();
	runtimeStartAbort = controller;
	runtimeStartPromise = startRuntimeOnce(controller.signal).finally(() => {
		runtimeStartPromise = null;
		if (runtimeStartAbort === controller) runtimeStartAbort = null;
	});
	return runtimeStartPromise;
}

async function ensureRuntimeAndRelay(state: StoredState, credential?: string) {
	const generation = connectorGeneration;
	try {
		await startRuntime();
	} catch (error) {
		if (!quitting && !suppressRuntimeRecovery && generation === connectorGeneration) await scheduleRuntimeRecovery(error);
		return;
	}
	if (quitting || suppressRuntimeRecovery || generation !== connectorGeneration || !localRuntimeReady) return;
	try {
		await startRelay(state, credential);
		if (relayConnected) publishStatus({ state: "connected", deviceId: state.deviceId, message: null });
	} catch (error) {
		if (!quitting && !suppressRuntimeRecovery && generation === connectorGeneration) await scheduleRelayRecovery(state, error instanceof Error ? error.message : String(error));
	}
}

async function handleRuntimeFailure(error: Error) {
	localRuntimeReady = false;
	runtimeIdentity = null;
	await scheduleRuntimeRecovery(error);
}

async function scheduleRuntimeRecovery(error: unknown) {
	if (quitting || suppressRuntimeRecovery || runtimeRestartTimer) return;
	lastRuntimeError = error instanceof Error ? error.message : String(error);
	localRuntimeReady = false;
	const generation = connectorGeneration;
	void showStartupPage(true).catch(publishConnectorError);
	try {
		await stopRelay();
	} catch (cleanupError) {
		if (quitting || suppressRuntimeRecovery || generation !== connectorGeneration) return;
		lastRuntimeError = `${lastRuntimeError} Recovery blocked: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
		publishStatus({ state: "error", deviceId: registeredState?.deviceId ?? null, message: lastRuntimeError });
		return;
	}
	if (quitting || suppressRuntimeRecovery || generation !== connectorGeneration || runtimeRestartTimer) return;
	const state = await readState();
	if (quitting || suppressRuntimeRecovery || generation !== connectorGeneration || runtimeRestartTimer) return;
	runtimeRecoveryAttempt += 1;
	const restart = nextRuntimeRestart(runtimeRecoveryAttempt);
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
		if (quitting || suppressRuntimeRecovery || generation !== connectorGeneration) return;
		void readState()
			.then((registered) => {
				if (quitting || suppressRuntimeRecovery || generation !== connectorGeneration) return;
				return registered ? ensureRuntimeAndRelay(registered) : startRuntime();
			})
			.catch((nextError) => {
				if (generation === connectorGeneration) return scheduleRuntimeRecovery(nextError);
			});
	}, restart.delayMs);
}

async function localApiReady(
	expectedIdentity = runtimeIdentity,
	expectedProcess = runtimeProcess,
) {
	if (
		!expectedIdentity ||
		!expectedProcess ||
		runtimeIdentity !== expectedIdentity ||
		runtimeProcess !== expectedProcess ||
		expectedProcess.exitCode !== null
	) return false;
	const challenge = randomBytes(32).toString("base64url");
	try {
		const response = await fetch(`${localApiOrigin}/api/local-mode/instance?challenge=${challenge}`, {
			signal: AbortSignal.timeout(1_500),
		});
		if (!response.ok || !verifyRuntimeIdentity(await response.json(), expectedIdentity.id, expectedIdentity.secret, challenge)) {
			throw new Error("Local API belongs to a different runtime instance");
		}
		return (
			runtimeIdentity === expectedIdentity &&
			runtimeProcess === expectedProcess &&
			expectedProcess.exitCode === null
		);
	} catch (error) {
		if ((error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED") return false;
		throw error;
	}
}

async function startRelay(state: StoredState, credential?: string) {
	if (quitting || suppressRuntimeRecovery || !localRuntimeReady || !runtimeIdentity) {
		throw new Error("Relay requires a running local Cohub instance");
	}
	if (relayStartPromise) return relayStartPromise;
	const identity = runtimeIdentity;
	const generation = relayGeneration;
	const starting = (async () => {
		await relayStopPromise;
		assertRelayStartCurrent(generation, identity);
		if (relayProcess && relayProcess.exitCode === null) {
			if (relayRuntimeId === identity.id && relayNodeIdentity === personalNodeId(state)) return;
			await stopRelayChild();
		}
		assertRelayStartCurrent(generation, identity);
		await startRelayOnce(state, identity, generation, credential);
	})();
	const tracked = starting.finally(() => {
		if (relayStartPromise === tracked) relayStartPromise = null;
	});
	relayStartPromise = tracked;
	return tracked;
}

function assertRelayStartCurrent(generation: number, identity: { id: string; secret: string }) {
	if (quitting || suppressRuntimeRecovery || !localRuntimeReady || generation !== relayGeneration || runtimeIdentity !== identity) {
		throw new Error("Relay startup was superseded or stopped");
	}
}

async function startRelayOnce(state: StoredState, identity: { id: string; secret: string }, generation: number, credential?: string) {
	const relayScript = app.isPackaged
		? join(process.resourcesPath, "relay-node.mjs")
		: join(app.getAppPath(), "resources", "relay-node.mjs");
	await access(relayScript);
	assertRelayStartCurrent(generation, identity);
	const relayCredential = credential ?? await readCredential(state.installationId);
	assertRelayStartCurrent(generation, identity);
	const nodeId = personalNodeId(state);
	publishStatus({ state: "connecting", deviceId: state.deviceId, message: null });
	const child = spawn(process.execPath, [relayScript], {
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
			NODE_ENV: "production",
			COHUB_LOCAL_RELAY_URL: `${alphaOrigin.replace("https:", "wss:")}/api/alpha/v1/nodes/${state.accountId}/${state.deviceId}/connect`,
			COHUB_LOCAL_RELAY_NODE_ID: nodeId,
			COHUB_LOCAL_RELAY_NODE_TOKEN: relayCredential,
			COHUB_LOCAL_DATA_DIR: dataDir(),
			SPACE_STORAGE_ROOT: join(dataDir(), "spaces"),
			COHUB_LOCAL_RELAY_API_ORIGIN: localApiOrigin,
			COHUB_LOCAL_RELAY_GATEWAY_ORIGIN: localGatewayOrigin,
			COHUB_DESKTOP_INSTANCE_SECRET: identity.secret,
			PUBLIC_CLOUD_API_ORIGIN: "https://api.cohub.live",
			PUBLIC_CLOUD_GATEWAY_ORIGIN: "wss://gateway.cohub.live/ws",
		},
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	relayProcess = child;
	relayRuntimeId = identity.id;
	relayNodeIdentity = nodeId;
	lastRelayError = null;
	const isCurrent = () => !quitting && !suppressRuntimeRecovery && localRuntimeReady && relayProcess === child && generation === relayGeneration && runtimeIdentity === identity;
	child.stdout?.on("data", (chunk) => {
		const message = String(chunk);
		logMessage("relay", message);
	});
	child.on("message", (message) => {
		if (!isCurrent() || !message || typeof message !== "object" || Reflect.get(message, "type") !== "relay-status" || Reflect.get(message, "nodeId") !== nodeId || Reflect.get(message, "pid") !== child.pid) return;
		lastRelayStatusAt = Date.now();
		const relayState = Reflect.get(message, "state");
		relayConnected = ["connected", "executing", "waiting-for-local-api"].includes(String(relayState));
		if (relayConnected) {
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
		} else {
			publishStatus({ state: "connecting", deviceId: state.deviceId, message: localRuntimeReady ? "Local Cohub is ready. Remote access is disconnected." : "Remote access is disconnected." });
		}
	});
	child.stderr?.on("data", (chunk) => {
		const message = String(chunk).trim();
		if (message) {
			if (isCurrent()) lastRelayError = message;
			logMessage("relay-error", message);
		}
	});
	child.on("error", (error) => {
		logMessage("relay-error", error.message);
		if (isCurrent()) lastRelayError = error.message;
	});
	child.once("exit", (code) => {
		if (relayProcess !== child) return;
		relayProcess = null;
		relayRuntimeId = null;
		relayNodeIdentity = null;
		relayConnected = false;
		if (!quitting && !suppressRuntimeRecovery && localRuntimeReady && runtimeIdentity === identity && generation === relayGeneration) {
			void scheduleRelayRecovery(
				state,
				lastRelayError ?? `Personal Node relay stopped (${code ?? "signal"})`,
			);
		}
	});
	try {
		await new Promise<void>((resolve, reject) => {
			const onSpawn = () => { child.removeListener("error", onError); resolve(); };
			const onError = (error: Error) => { child.removeListener("spawn", onSpawn); reject(error); };
			child.once("spawn", onSpawn);
			child.once("error", onError);
		});
		assertRelayStartCurrent(generation, identity);
		if (relayProcess !== child || child.exitCode !== null || child.signalCode != null) {
			throw new Error("Relay stopped before startup completed");
		}
	} catch (error) {
		if (!child.pid && relayProcess === child) {
			relayProcess = null;
			relayRuntimeId = null;
			relayNodeIdentity = null;
		}
		throw error;
	}
}

function scheduleRelayRecovery(state: StoredState, message: string) {
	if (quitting || suppressRuntimeRecovery || !localRuntimeReady || relayRestartTimer) return;
	const generation = relayGeneration;
	relayRecoveryAttempt += 1;
	const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(relayRecoveryAttempt - 1, 5));
	publishStatus({
		state: "connecting",
		deviceId: state.deviceId,
		message: `${message} Reconnecting in ${Math.ceil(delayMs / 1_000)}s.`,
	});
	relayRestartTimer = setTimeout(() => {
		relayRestartTimer = null;
		if (quitting || suppressRuntimeRecovery || !localRuntimeReady || generation !== relayGeneration) return;
		void startRelay(state).catch((error) => {
			scheduleRelayRecovery(
				state,
				error instanceof Error ? error.message : String(error),
			);
		});
	}, delayMs);
}

async function stopRelay() {
	relayGeneration += 1;
	if (relayRestartTimer) {
		clearTimeout(relayRestartTimer);
		relayRestartTimer = null;
	}
	if (relayStopPromise) return relayStopPromise;
	const pendingStart = relayStartPromise;
	const stoppingChild = stopRelayChild();
	const stopping = Promise.all([
		stoppingChild,
		pendingStart?.catch((error) => logMessage("relay-start-cancelled", String(error))),
	]).then(() => undefined);
	const tracked = stopping.finally(() => {
		if (relayStopPromise === tracked) relayStopPromise = null;
	});
	relayStopPromise = tracked;
	return tracked;
}

async function stopRelayChild() {
	const child = relayProcess;
	relayProcess = null;
	relayRuntimeId = null;
	relayNodeIdentity = null;
	relayConnected = false;
	if (!child || !child.pid || child.exitCode !== null || child.signalCode != null) return;
	let onExit: (() => void) | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			let killTimeout: ReturnType<typeof setTimeout> | null = null;
			const termTimeout = setTimeout(() => {
				child.kill("SIGKILL");
				killTimeout = setTimeout(() => reject(new Error("Relay process did not exit after SIGKILL")), 5_000);
			}, 5_000);
			onExit = () => {
				clearTimeout(termTimeout);
				if (killTimeout) clearTimeout(killTimeout);
				resolve();
			};
			child.once("exit", onExit);
			child.kill("SIGTERM");
		});
	} catch (error) {
		if (!relayProcess && child.exitCode === null && child.signalCode == null) relayProcess = child;
		throw error;
	} finally {
		if (onExit) child.removeListener("exit", onExit);
	}
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
	runtimeStartAbort?.abort(new Error("Local Cohub startup stopped"));
	runtimeProcess = null;
	localRuntimeReady = false;
	runtimeIdentity = null;
	await pendingStart?.catch(() => undefined);
	await stopOwnedRuntime();
}

async function reconnectConnector() {
	if (registrationPromise) await registrationPromise;
	if (quitting) return;
	if (reconnectPromise) return reconnectPromise;
	const reconnecting = reconnectConnectorOnce().finally(() => {
		if (reconnectPromise === reconnecting) reconnectPromise = null;
	});
	reconnectPromise = reconnecting;
	return reconnecting;
}

async function reconnectConnectorOnce() {
	const generation = ++connectorGeneration;
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
	if (quitting || generation !== connectorGeneration) return;
	const state = await readState();
	if (quitting || generation !== connectorGeneration) return;
	if (state) await ensureRuntimeAndRelay(state);
	else {
		try { await startRuntime(); }
		catch (error) {
			if (generation === connectorGeneration) await scheduleRuntimeRecovery(error);
		}
	}
}

async function quitConnector() {
	if (quitting) return;
	quitting = true;
	connectorGeneration += 1;
	if (statusHeartbeatTimer) {
		clearInterval(statusHeartbeatTimer);
		statusHeartbeatTimer = null;
	}
	const state = await readState().catch(() => null);
	publishStatus({ state: "stopped", deviceId: state?.deviceId ?? null, message: null });
	await stopRelay().catch((error) => logMessage("shutdown-error", String(error)));
	await statusReporter.flush();
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
function requireLocalWindow(event: Electron.IpcMainInvokeEvent, allowStartup = false) {
	if (quitting || event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) {
		throw new Error("Action must be requested by the local Cohub window");
	}
	const url = event.senderFrame.url;
	if (new URL(url).origin !== localWebOrigin && !(allowStartup && url === startupPageUrl)) {
		throw new Error("Action must be requested by the local Cohub window");
	}
}
ipcMain.handle("cohub-desktop:status", (event) => { requireLocalWindow(event, true); return currentStatus; });
ipcMain.handle("cohub-desktop:retry", async (event) => { requireLocalWindow(event, true); await reconnectConnector(); });
ipcMain.handle("cohub-desktop:diagnostics", async (event) => { requireLocalWindow(event, true); await showDiagnostics(); });
ipcMain.handle("cohub-desktop:quit", (event) => { requireLocalWindow(event, true); void quitConnector(); });
ipcMain.handle("cohub-desktop:sign-in", async (event) => {
	requireLocalWindow(event);
	await beginConnectorSignIn();
	if (!await readState()) throw new Error("Sign-in did not complete");
});
app.on("window-all-closed", () => { /* Background tasks belong to the client, not its window. */ });
if (!hasSingleInstanceLock) {
	app.quit();
} else {
	app.on("second-instance", () => void openLocalCohub().catch(publishConnectorError));
	app.on("activate", () => void openLocalCohub().catch(publishConnectorError));
	void app.whenReady().then(async () => {
		app.dock?.hide();
		createTray();
		void showLocalWindow().catch(publishConnectorError);
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
			}
			if (!process.env.COHUB_DESKTOP_TEST_HOME && !restored && !app.getLoginItemSettings().openAtLogin) {
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
		startStatusHeartbeat();
		void openLocalCohub().catch(publishConnectorError);
	});
}

app.on("before-quit", (event) => {
	if (allowQuit || !hasSingleInstanceLock) return;
	event.preventDefault();
	void quitConnector();
});
