import { HttpError } from "@neta-art/cohub";
import type { HandleClientError } from "@sveltejs/kit";
import { installCohubDebuggerConsoleExports } from "$lib/debugger";
import { installCohubServiceWorkerUpdateLifecycle } from "$lib/service-worker-update";

installCohubDebuggerConsoleExports();
installCohubServiceWorkerUpdateLifecycle();

// SvelteKit replaces unknown thrown errors with a generic "Internal Error";
// keep the real SDK HttpError message so error boundaries can classify it.
export const handleError: HandleClientError = ({ error, message }) => {
	console.error(error);
	return error instanceof HttpError ? { message: error.message } : { message };
};
