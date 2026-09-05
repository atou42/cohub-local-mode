import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDev2ResourceConfig } from "./dev2-resource-guard-core.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const configPath = resolve(
	repoRoot,
	process.env.COHUB_DEV2_WRANGLER_CONFIG ?? "apps/local-relay/wrangler.dev2.json",
);
const webConfigPath = resolve(
	repoRoot,
	process.env.COHUB_DEV2_WEB_WRANGLER_CONFIG ?? "apps/web/wrangler.dev2.json",
);

const result = validateDev2ResourceConfig(
	await readFile(configPath, "utf8"),
	await readFile(webConfigPath, "utf8"),
);
process.stdout.write(
	`Dev2 Cloudflare resources are isolated: ${result.worker} ${result.webWorker} ${result.origin}\n`,
);
