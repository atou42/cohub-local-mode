import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAlphaResourceConfig } from "./alpha-resource-guard-core.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const configPath = resolve(
	process.env.COHUB_ALPHA_WRANGLER_CONFIG ??
		resolve(repoRoot, "apps/local-relay/wrangler.alpha.toml"),
);
const webConfigPath = resolve(
	process.env.COHUB_ALPHA_WEB_WRANGLER_CONFIG ??
		resolve(repoRoot, "apps/web/wrangler.alpha.toml"),
);
const result = validateAlphaResourceConfig(
	await readFile(configPath, "utf8"),
	await readFile(webConfigPath, "utf8"),
);
process.stdout.write(
	`Alpha Cloudflare resources are isolated: ${result.worker} ${result.webWorker} ${result.origin}\n`,
);
