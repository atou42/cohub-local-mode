import type { AppNavigationOpenMessage } from "@cohub/protocol/app-navigation";

export const APP_NAVIGATION_OPEN_EVENT = "cohub:app-navigation-open";

export type AppNavigationOpenRequest = {
	spaceId: string;
	message: AppNavigationOpenMessage;
	fallbackHref?: string;
};

export function requestAppNavigation(request: AppNavigationOpenRequest) {
	if (typeof window === "undefined") return false;
	const event = new CustomEvent<AppNavigationOpenRequest>(
		APP_NAVIGATION_OPEN_EVENT,
		{ cancelable: true, detail: request },
	);
	window.dispatchEvent(event);
	return event.defaultPrevented;
}
