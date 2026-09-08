export interface Dev2Release {
	schemaVersion: 1;
	version: string;
	filename: string;
	sha256: string;
	bytes: number;
	platform: "darwin";
	arch: "arm64";
	minimumSystemVersion: "13.0";
	signature: "ad-hoc";
	notarized: false;
	publishedAt: string;
}

export const DEV2_RELEASE_VERSION: RegExp;
export function parseDev2Release(value: unknown): Dev2Release;
export function releaseObjectKey(release: Dev2Release): string;
export function releaseManifestKey(version: string): string;
export function releaseDownloadPath(release: Dev2Release): string;
