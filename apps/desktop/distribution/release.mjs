export const DEV2_RELEASE_VERSION = /^\d+\.\d+\.\d+-dev2\.\d+$/;

export function parseDev2Release(value) {
	const fields = ["schemaVersion", "version", "filename", "sha256", "bytes", "platform", "arch", "minimumSystemVersion", "signature", "notarized", "publishedAt"];
	if (!value || typeof value !== "object" || Array.isArray(value) ||
		Object.keys(value).some(key => !fields.includes(key)) ||
		value.schemaVersion !== 1 || typeof value.version !== "string" || !DEV2_RELEASE_VERSION.test(value.version) ||
		value.filename !== `Cohub-Dev2-${value.version}-arm64.dmg` ||
		typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
		!Number.isSafeInteger(value.bytes) || value.bytes <= 0 ||
		value.platform !== "darwin" || value.arch !== "arm64" ||
		value.minimumSystemVersion !== "13.0" || value.signature !== "ad-hoc" ||
		value.notarized !== false || typeof value.publishedAt !== "string" ||
		!Number.isFinite(Date.parse(value.publishedAt))) {
		throw new Error("Dev2 release metadata is invalid");
	}
	return value;
}

export function releaseObjectKey(release) {
	parseDev2Release(release);
	return `releases/${release.version}/${release.sha256}/${release.filename}`;
}

export function releaseManifestKey(version) {
	if (!DEV2_RELEASE_VERSION.test(version)) throw new Error("Invalid Dev2 release version");
	return `releases/${version}/release.json`;
}

export function releaseDownloadPath(release) {
	parseDev2Release(release);
	return `/downloads/${release.filename}`;
}
