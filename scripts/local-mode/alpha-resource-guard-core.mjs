const REQUIRED_MARKERS = [
	'name = "cohub-personal-node-alpha-dev"',
	'pattern = "dev-cohub.atou.cc/api/alpha/*"',
	'pattern = "dev-cohub.atou.cc/healthz"',
	'ALLOWED_ORIGIN = "https://dev-cohub.atou.cc"',
	'class_name = "PersonalAccount"',
	'class_name = "LocalNodeRelay"',
	'name = "NODES"',
	'queue = "cohub-personal-node-alpha-dev-wakeups"',
	'bucket_name = "cohub-personal-node-alpha-dev-attachments"',
];

const REQUIRED_WEB_MARKERS = [
	'name = "cohub-personal-node-alpha-web-dev"',
	'pattern = "dev-cohub.atou.cc"',
	'custom_domain = true',
	'PUBLIC_COHUB_LOCAL_MODE = "true"',
	'PUBLIC_PERSONAL_NODE_ALPHA = "true"',
	'PUBLIC_API_ORIGIN = "https://dev-cohub.atou.cc"',
];

const FORBIDDEN_MARKERS = [
	'name = "cohub-local-relay"',
	'name = "cohub-local-web"',
	'pattern = "cohub.atou.cc',
	'pattern = "relay-node.atou.cc',
	'queue = "cohub-local-relay-',
	'bucket_name = "cohub-local-relay-attachments"',
];

export function validateAlphaResourceConfig(source, webSource) {
	if (typeof source !== "string" || !source.trim()) {
		throw new Error("Alpha Cloudflare configuration is empty");
	}
	if (typeof webSource !== "string" || !webSource.trim()) {
		throw new Error("Alpha Web Cloudflare configuration is empty");
	}
	for (const marker of REQUIRED_MARKERS) {
		if (!source.includes(marker)) {
			throw new Error(`Alpha Cloudflare configuration is missing: ${marker}`);
		}
	}
	for (const marker of REQUIRED_WEB_MARKERS) {
		if (!webSource.includes(marker)) {
			throw new Error(`Alpha Web Cloudflare configuration is missing: ${marker}`);
		}
	}
	for (const marker of FORBIDDEN_MARKERS) {
		if (source.includes(marker) || webSource.includes(marker)) {
			throw new Error(`Alpha Cloudflare configuration targets production: ${marker}`);
		}
	}
	if (/\b(?:NODE_ID|OWNER_EMAIL|OWNER_USER_ID|TEAM_DOMAIN|POLICY_AUD)\s*=/.test(`${source}\n${webSource}`)) {
		throw new Error("Alpha Cloudflare configuration contains owner-only relay settings");
	}
	return {
		worker: "cohub-personal-node-alpha-dev",
		webWorker: "cohub-personal-node-alpha-web-dev",
		origin: "https://dev-cohub.atou.cc",
	};
}
