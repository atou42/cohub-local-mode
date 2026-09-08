import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { localCliProxyArgv, localCliProxyExecutionKey, parseLocalSystemProxy, resolveLocalCliProxyOverrides } from "./local-cli-proxy.js";

function settings(port: number) {
	return {
		HTTPEnable: 1, HTTPProxy: "127.0.0.1", HTTPPort: port,
		HTTPSEnable: 1, HTTPSProxy: "127.0.0.1", HTTPSPort: port,
		SOCKSEnable: 1, SOCKSProxy: "127.0.0.1", SOCKSPort: port,
	};
}

async function context(t: { after: (callback: () => Promise<unknown>) => void }) {
	const root = await mkdtemp(join(tmpdir(), "cohub-cli-proxy-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return {
		root,
		dependencies: {
			platform: "darwin" as const,
			env: { COHUB_NODE_ORIGIN: "local", COHUB_LOCAL_DATA_DIR: root },
			readSettings: async () => settings(7894),
			assertReachable: async () => {},
		},
	};
}

test("system proxy parsing uses HTTPS settings and the actual SOCKS port", () => {
	const parsed = parseLocalSystemProxy({ ...settings(7894), HTTPPort: 7890, SOCKSPort: 7895 });
	assert.equal(parsed?.http.url, "http://127.0.0.1:7894");
	assert.equal(parsed?.socks?.url, "socks5h://127.0.0.1:7895");
	assert.equal(parseLocalSystemProxy({ HTTPEnable: 1, HTTPProxy: "localhost", HTTPPort: 7894 })?.http.url, "http://localhost:7894");
	assert.equal(parseLocalSystemProxy({ HTTPEnable: 0, HTTPSEnable: 0, SOCKSEnable: 0 }), null);
	assert.equal(parseLocalSystemProxy({}), null);
});

test("invalid or unsupported proxy settings never become an unconfigured proxy", () => {
	for (const value of [null, [], "bad", { HTTPEnable: "1" }, { ...settings(7894), HTTPPort: 0 }, { ...settings(7894), HTTPSPort: 65536 }, { ...settings(7894), HTTPSPort: 1.5 }, { ...settings(7894), HTTPSPort: "7894" }, { ...settings(7894), HTTPSProxy: "proxy.example.com" }, { ...settings(7894), HTTPSProxy: "127.0.0.1; echo unsafe" }, { HTTPEnable: 1 }, { ProxyAutoConfigEnable: 1 }, { ProxyAutoDiscoveryEnable: 1 }, { SOCKSEnable: 1, SOCKSProxy: "127.0.0.1", SOCKSPort: 7894 }]) {
		assert.throws(() => parseLocalSystemProxy(value));
	}
});

test("cloud and non-macOS processes do not inspect the host proxy", async () => {
	const readSettings = async () => { throw new Error("must not read"); };
	assert.deepEqual(await resolveLocalCliProxyOverrides({ platform: "linux", env: { COHUB_NODE_ORIGIN: "local" }, readSettings }), {});
	assert.deepEqual(await resolveLocalCliProxyOverrides({ platform: "darwin", env: { COHUB_NODE_ORIGIN: "cloud" }, readSettings }), {});
	assert.deepEqual(await resolveLocalCliProxyOverrides({ platform: "darwin", env: {}, readSettings }), {});
});

test("a genuinely unconfigured proxy leaves existing CLI behavior unchanged", async () => {
	assert.deepEqual(await resolveLocalCliProxyOverrides({ platform: "darwin", env: { COHUB_NODE_ORIGIN: "local" }, readSettings: async () => ({}) }), {});
});

test("each CLI launch reads the current port without changing old files or parent environment", async (t) => {
	const { dependencies } = await context(t);
	let port = 7890;
	let reads = 0;
	const reached: number[] = [];
	const env = { ...dependencies.env, HTTPS_PROXY: "http://old.invalid:80", NO_PROXY: "internal.local", no_proxy: "custom.local" };
	const original = { ...env };
	const deps = {
		...dependencies, env,
		readSettings: async () => { reads += 1; return settings(port); },
		assertReachable: async (entry: { port: number }) => { reached.push(entry.port); },
	};
	const first = await resolveLocalCliProxyOverrides(deps);
	port = 7894;
	const second = await resolveLocalCliProxyOverrides(deps);
	assert.equal(reads, 2);
	assert.deepEqual(reached, [7890, 7894]);
	assert.equal(first.HTTPS_PROXY, "http://127.0.0.1:7890");
	assert.equal(second.HTTPS_PROXY, "http://127.0.0.1:7894");
	assert.equal(second.HTTP_PROXY, second.HTTPS_PROXY);
	assert.equal(second.http_proxy, second.HTTP_PROXY);
	assert.equal(second.https_proxy, second.HTTPS_PROXY);
	assert.equal(second.GROK_HTTP_PROXY, second.HTTPS_PROXY);
	assert.equal(second.GROK_SOCKS_PROXY, "socks5h://127.0.0.1:7894");
	assert.equal(second.all_proxy, second.ALL_PROXY);
	assert.equal(second.NO_PROXY, "internal.local,custom.local,localhost,127.0.0.1,::1");
	assert.equal(second.no_proxy, second.NO_PROXY);
	assert.notEqual(first.CODEX_PROXY_CONFIG, second.CODEX_PROXY_CONFIG);
	assert.equal(await readFile(first.CODEX_PROXY_CONFIG!, "utf8"), "http://127.0.0.1:7890\n");
	assert.equal(await readFile(second.CODEX_PROXY_CONFIG!, "utf8"), "http://127.0.0.1:7894\n");
	assert.deepEqual(env, original);
	assert.equal("COHUB_LOCAL_DATA_DIR" in second, false);
	assert.equal((await lstat(second.CODEX_PROXY_CONFIG!)).mode & 0o777, 0o600);
});

test("concurrent probes atomically publish the same complete wrapper configuration", async (t) => {
	const { root, dependencies } = await context(t);
	const results = await Promise.all(Array.from({ length: 12 }, () => resolveLocalCliProxyOverrides(dependencies)));
	assert.equal(new Set(results.map((result) => result.CODEX_PROXY_CONFIG)).size, 1);
	assert.equal(await readFile(results[0]!.CODEX_PROXY_CONFIG!, "utf8"), "http://127.0.0.1:7894\n");
	assert.equal((await readdir(join(root, "cli-proxy"))).length, 1);
});

test("proxy failures are explicit and do not create a direct or stale fallback", async (t) => {
	const { root, dependencies } = await context(t);
	await assert.rejects(resolveLocalCliProxyOverrides({ ...dependencies, readSettings: async () => { throw new Error("settings unavailable"); } }), /settings unavailable/);
	await assert.rejects(resolveLocalCliProxyOverrides({ ...dependencies, assertReachable: async () => { throw new Error("proxy unreachable"); } }), /proxy unreachable/);
	assert.deepEqual(await readdir(root), []);
	await assert.rejects(resolveLocalCliProxyOverrides({ ...dependencies, env: { COHUB_NODE_ORIGIN: "local" } }), /data directory is missing/);
	await assert.rejects(resolveLocalCliProxyOverrides({ ...dependencies, env: { COHUB_NODE_ORIGIN: "local", COHUB_LOCAL_DATA_DIR: "relative" } }), /absolute path/);
});

test("corrupt, public or symlinked proxy files are preserved rather than overwritten", async (t) => {
	const { root, dependencies } = await context(t);
	const result = await resolveLocalCliProxyOverrides(dependencies);
	const path = result.CODEX_PROXY_CONFIG!;
	await writeFile(path, "broken\n");
	await assert.rejects(resolveLocalCliProxyOverrides(dependencies), /invalid/);
	assert.equal(await readFile(path, "utf8"), "broken\n");
	await writeFile(path, "http://127.0.0.1:7894\n");
	await chmod(path, 0o644);
	await assert.rejects(resolveLocalCliProxyOverrides(dependencies), /invalid/);
	await unlink(path);
	const unrelated = join(root, "unrelated.txt");
	await writeFile(unrelated, "preserve me");
	await symlink(unrelated, path);
	await assert.rejects(resolveLocalCliProxyOverrides(dependencies));
	assert.equal(await readFile(unrelated, "utf8"), "preserve me");
	assert.equal((await lstat(path)).isSymbolicLink(), true);
});

test("a child receives wrapper overrides without altering global proxy configuration", async (t) => {
	const { root, dependencies } = await context(t);
	const globalConfig = join(root, "existing-proxy.txt");
	await writeFile(globalConfig, "http://127.0.0.1:7890\n");
	const parent = { ...process.env, CODEX_PROXY_CONFIG: globalConfig, GROK_HTTP_PROXY: "http://127.0.0.1:7890" };
	const overrides = await resolveLocalCliProxyOverrides(dependencies);
	const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", 'import {readFile} from "node:fs/promises"; console.log(JSON.stringify({codex:await readFile(process.env.CODEX_PROXY_CONFIG,"utf8"),grok:process.env.GROK_HTTP_PROXY,https:process.env.HTTPS_PROXY}));'], { env: { ...parent, ...overrides }, timeout: 5000 });
	assert.deepEqual(JSON.parse(stdout), { codex: "http://127.0.0.1:7894\n", grok: "http://127.0.0.1:7894", https: "http://127.0.0.1:7894" });
	assert.equal(parent.CODEX_PROXY_CONFIG, globalConfig);
	assert.equal(await readFile(globalConfig, "utf8"), "http://127.0.0.1:7890\n");
});

test("the sandbox argv path overrides stale inherited proxy fields without invoking a shell", async (t) => {
	const { dependencies } = await context(t);
	const overrides = await resolveLocalCliProxyOverrides(dependencies);
	const originalArgv = [process.execPath, "--input-type=module", "-e", 'console.log(JSON.stringify({proxy:process.env.HTTPS_PROXY,argument:process.argv[1],path:process.env.PATH}));', "literal; $(echo not-executed)"];
	const argv = localCliProxyArgv(originalArgv, overrides);
	const { stdout } = await promisify(execFile)(argv[0]!, argv.slice(1), { env: { ...process.env, HTTPS_PROXY: "http://127.0.0.1:7890", PATH: "/unchanged-test-path" }, timeout: 5000 });
	assert.deepEqual(JSON.parse(stdout), { proxy: "http://127.0.0.1:7894", argument: "literal; $(echo not-executed)", path: "/unchanged-test-path" });
	assert.deepEqual(localCliProxyArgv(originalArgv), originalArgv);
	assert.throws(() => localCliProxyArgv(originalArgv, { PATH: "/unauthorized-override" }), /unsupported environment/);
	assert.throws(() => localCliProxyArgv(originalArgv, { HTTPS_PROXY: "bad\0value" }), /unsupported environment/);
});

test("a changed proxy creates a new execution context without mutating an existing one", () => {
	const previous = { HTTPS_PROXY: "http://127.0.0.1:7890", ALL_PROXY: "socks5h://127.0.0.1:7891" };
	const oldKey = localCliProxyExecutionKey("existing-context", previous);
	assert.equal(localCliProxyExecutionKey("existing-context", {}), "existing-context");
	assert.equal(localCliProxyExecutionKey("existing-context", { ALL_PROXY: previous.ALL_PROXY, HTTPS_PROXY: previous.HTTPS_PROXY }), oldKey);
	assert.notEqual(localCliProxyExecutionKey("existing-context", { ...previous, HTTPS_PROXY: "http://127.0.0.1:7894" }), oldKey);
	assert.notEqual(localCliProxyExecutionKey("existing-context", { ...previous, ALL_PROXY: "socks5h://127.0.0.1:7894" }), oldKey);
	assert.equal(localCliProxyExecutionKey("existing-context", previous), oldKey);
});
