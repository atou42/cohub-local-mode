import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

type ProxyEndpoint = { host: string; port: number; url: string };
type SystemProxy = { http: ProxyEndpoint; socks: ProxyEndpoint | null };
type Dependencies = {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	readSettings?: () => Promise<unknown>;
	assertReachable?: (endpoint: ProxyEndpoint) => Promise<void>;
};

const PROXY_ENV_KEYS = new Set([
	"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy",
	"NO_PROXY", "no_proxy", "CODEX_PROXY_CONFIG", "GROK_HTTP_PROXY", "GROK_SOCKS_PROXY",
]);

export function localCliProxyArgv(argv: readonly string[], overrides: Record<string, string> = {}): string[] {
	const entries = Object.entries(overrides);
	if (!entries.length) return [...argv];
	if (entries.some(([key, value]) => !PROXY_ENV_KEYS.has(key) || value.includes("\0"))) {
		throw new Error("Local CLI proxy overrides contain an unsupported environment variable.");
	}
	// The sandbox deliberately preserves inherited environment variables.
	// Override only the trusted proxy fields without relaxing that policy.
	return ["/usr/bin/env", ...entries.map(([key, value]) => `${key}=${value}`), ...argv];
}

export function localCliProxyExecutionKey(key: string, overrides: Record<string, string>): string {
	if (!Object.keys(overrides).length) return key;
	const fingerprint = createHash("sha256").update(JSON.stringify(Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
	return `${key}:proxy:${fingerprint}`;
}

const PROXY_SETTINGS_SCRIPT = `
ObjC.import("CFNetwork");
var settings = ObjC.deepUnwrap(ObjC.castRefToObject($.CFNetworkCopySystemProxySettings()));
if (!settings || typeof settings !== "object") throw new Error("System proxy settings are unavailable");
var result = {};
["HTTPEnable", "HTTPProxy", "HTTPPort", "HTTPSEnable", "HTTPSProxy", "HTTPSPort", "SOCKSEnable", "SOCKSProxy", "SOCKSPort", "ProxyAutoConfigEnable", "ProxyAutoDiscoveryEnable"].forEach(function(key) {
  if (Object.prototype.hasOwnProperty.call(settings, key)) result[key] = settings[key];
});
JSON.stringify(result);
`;

export function parseLocalSystemProxy(value: unknown): SystemProxy | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("macOS returned invalid system proxy settings.");
	}
	const settings = value as Record<string, unknown>;
	const enabled = (name: string) => {
		const flag = settings[name];
		if (flag === undefined || flag === 0) return false;
		if (flag === 1) return true;
		throw new Error(`macOS system proxy setting ${name} is invalid.`);
	};
	if (enabled("ProxyAutoConfigEnable") || enabled("ProxyAutoDiscoveryEnable")) {
		throw new Error("Local CLI proxy discovery requires a manual loopback proxy; automatic proxy scripts are not supported.");
	}
	const endpoint = (prefix: "HTTP" | "HTTPS" | "SOCKS"): ProxyEndpoint | null => {
		if (!enabled(`${prefix}Enable`)) return null;
		const host = settings[`${prefix}Proxy`];
		const port = settings[`${prefix}Port`];
		if ((host !== "127.0.0.1" && host !== "localhost") || !Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
			throw new Error(`macOS ${prefix} proxy must have a loopback host and a valid port.`);
		}
		return { host, port: port as number, url: `${prefix === "SOCKS" ? "socks5h" : "http"}://${host}:${port}` };
	};
	const http = endpoint("HTTP");
	const https = endpoint("HTTPS");
	const socks = endpoint("SOCKS");
	if (!http && !https && !socks) return null;
	if (!http && !https) throw new Error("Local CLI proxy discovery requires an HTTP or HTTPS proxy, not only SOCKS.");
	return { http: (https ?? http)!, socks };
}

async function readSystemProxySettings(): Promise<unknown> {
	let stdout: string;
	try {
		({ stdout } = await promisify(execFile)("/usr/bin/osascript", ["-l", "JavaScript", "-e", PROXY_SETTINGS_SCRIPT], {
			timeout: 5000, killSignal: "SIGKILL", maxBuffer: 16 * 1024, encoding: "utf8",
		}));
	} catch {
		throw new Error("macOS system proxy settings could not be read.");
	}
	try {
		return JSON.parse(stdout);
	} catch {
		throw new Error("macOS returned invalid system proxy settings.");
	}
}

async function assertProxyReachable(endpoint: ProxyEndpoint): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const socket = createConnection({ host: endpoint.host, port: endpoint.port });
		const timer = setTimeout(() => finish(new Error(`System proxy at ${endpoint.host}:${endpoint.port} is not reachable.`)), 2000);
		const finish = (error?: Error) => {
			clearTimeout(timer);
			socket.destroy();
			error ? reject(error) : resolve();
		};
		socket.once("connect", () => finish());
		socket.once("error", () => finish(new Error(`System proxy at ${endpoint.host}:${endpoint.port} is not reachable.`)));
	});
}

async function codexProxyConfig(dataRoot: string, url: string): Promise<string> {
	if (!isAbsolute(dataRoot)) throw new Error("Cohub local data directory must be an absolute path for CLI proxy discovery.");
	const directory = join(dataRoot, "cli-proxy");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	if (!(await lstat(directory)).isDirectory()) throw new Error("Cohub CLI proxy directory is not a regular directory.");
	const path = join(directory, `${createHash("sha256").update(url).digest("hex")}.txt`);
	const expected = `${url}\n`;
	const verify = async () => {
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = await file.stat();
			if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size !== Buffer.byteLength(expected) || await file.readFile("utf8") !== expected) {
				throw new Error("Cohub CLI proxy configuration is invalid; it was not overwritten.");
			}
		} finally {
			await file.close();
		}
	};
	try {
		await verify();
		return path;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	// Publish a complete, immutable file so concurrent probes and existing CLI
	// processes never observe an empty file or a different port at the same path.
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	await writeFile(temporary, expected, { flag: "wx", mode: 0o600 });
	try {
		try {
			await link(temporary, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		await verify();
	} finally {
		await unlink(temporary);
	}
	return path;
}

export async function resolveLocalCliProxyOverrides(dependencies: Dependencies = {}): Promise<Record<string, string>> {
	const env = dependencies.env ?? process.env;
	if ((dependencies.platform ?? process.platform) !== "darwin" || env.COHUB_NODE_ORIGIN !== "local") return {};
	const proxy = parseLocalSystemProxy(await (dependencies.readSettings ?? readSystemProxySettings)());
	// An unconfigured system proxy is a normal value. A configured but broken
	// proxy instead fails above or below; it must never silently become direct.
	if (!proxy) return {};
	const dataRoot = env.COHUB_LOCAL_DATA_DIR;
	if (!dataRoot) throw new Error("Cohub local data directory is missing for CLI proxy discovery.");
	const endpoints = [proxy.http, ...(proxy.socks ? [proxy.socks] : [])];
	const unique = new Map(endpoints.map((entry) => [`${entry.host}:${entry.port}`, entry]));
	await Promise.all([...unique.values()].map(dependencies.assertReachable ?? assertProxyReachable));
	const configPath = await codexProxyConfig(dataRoot, proxy.http.url);
	const allProxy = proxy.socks?.url ?? proxy.http.url;
	const noProxy = [...new Set([...(env.NO_PROXY ?? "").split(","), ...(env.no_proxy ?? "").split(","), "localhost", "127.0.0.1", "::1"].map((item) => item.trim()).filter(Boolean))].join(",");
	return {
		HTTP_PROXY: proxy.http.url, http_proxy: proxy.http.url,
		HTTPS_PROXY: proxy.http.url, https_proxy: proxy.http.url,
		ALL_PROXY: allProxy, all_proxy: allProxy,
		NO_PROXY: noProxy, no_proxy: noProxy,
		CODEX_PROXY_CONFIG: configPath,
		GROK_HTTP_PROXY: proxy.http.url, GROK_SOCKS_PROXY: allProxy,
	};
}
