import { isDeepStrictEqual } from "node:util";

export const DEV2_RELEASE_BUCKET = "cohub-personal-node-dev2-releases";

export function validateDev2DownloadsConfig(config) {
	const expected = {
		name: "cohub-personal-node-dev2-downloads",
		main: "worker.mjs",
		compatibility_date: "2026-08-25",
		workers_dev: false,
		routes: [{ pattern: "dev2-cohub.atou.cc/downloads/*", zone_name: "atou.cc" }],
		r2_buckets: [{ binding: "RELEASES", bucket_name: DEV2_RELEASE_BUCKET, remote: true }],
	};
	if (!isDeepStrictEqual(config, expected)) throw new Error("Downloads must use only the dedicated Dev2 worker, route and release bucket");
}
