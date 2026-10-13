import { type ResourceAppTarget, resourceAppLaunch } from "@cohub/protocol";
import type { AppDetailResponse } from "@neta-art/cohub";
import { resourceAppRef } from "./resource-app-route";

export function createResourceAppOpener(options: {
	getSpaceId: () => string;
	load: (ref: string) => Promise<{ detail: AppDetailResponse }>;
	getLaunch: (appId: string) => string | undefined;
	settle: (appId: string) => Promise<boolean>;
	open: (detail: AppDetailResponse, launch: { hash: string }) => void;
	onCancelled: () => void;
}) {
	const loads = new Map<string, Promise<{ detail: AppDetailResponse }>>();
	let sequence = 0;
	return {
		cancel() {
			sequence += 1;
		},
		async open(target: ResourceAppTarget): Promise<boolean> {
			const ref = resourceAppRef(target);
			const request = ++sequence;
			const spaceId = options.getSpaceId();
			const current = () =>
				request === sequence && spaceId === options.getSpaceId();
			try {
				let pending = loads.get(ref);
				if (!pending) {
					pending = options.load(ref);
					loads.set(ref, pending);
					void pending.catch(() => loads.delete(ref));
				}
				const { detail } = await pending;
				if (!current()) return true;
				if (detail.app.status === "disabled" || !detail.content) {
					loads.delete(ref);
					return false;
				}
				const launch = resourceAppLaunch(spaceId, target);
				const existing = options.getLaunch(detail.app.id);
				if (
					existing !== undefined &&
					existing !== launch.hash &&
					!(await options.settle(detail.app.id))
				) {
					if (current()) options.onCancelled();
					return true;
				}
				if (current()) options.open(detail, launch);
				return true;
			} catch (error) {
				if (!current()) return true;
				console.warn("Failed to open resource App", error);
				return false;
			}
		},
	};
}
