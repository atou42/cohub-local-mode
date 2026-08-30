const DYNAMIC_IMPORT_FAILURE =
	/(?:failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed)/i;

export const FAILED_DYNAMIC_IMPORT_STORAGE_KEY = "cohub:failed-dynamic-import";

/**
 * Returns a stable signature for a failed Vite route/module import. The URL is
 * preferred so one stale asset can trigger one recovery without masking a
 * later deployment that fails on a different asset.
 */
export function getFailedDynamicImportSignature(error: unknown): string | null {
	const message = error instanceof Error ? error.message : String(error ?? "");
	if (!DYNAMIC_IMPORT_FAILURE.test(message)) return null;

	const assetUrl = message.match(
		/(?:https?:\/\/[^\s'")]+|\/_app\/immutable\/[^\s'")]+)/,
	)?.[0];
	return assetUrl ?? message;
}

export function shouldReloadForFailedDynamicImport(
	error: unknown,
	previousSignature: string | null,
): string | null {
	const signature = getFailedDynamicImportSignature(error);
	return signature && signature !== previousSignature ? signature : null;
}

export function clearFailedDynamicImportRecovery(
	storage: Pick<Storage, "removeItem">,
) {
	storage.removeItem(FAILED_DYNAMIC_IMPORT_STORAGE_KEY);
}
