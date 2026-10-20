import { type Renderer, Ticker } from "pixi.js";

export function scheduleBoardMaintenance(renderer: Renderer): () => void {
	(renderer.events.setTargetElement as (target: HTMLElement | null) => void)(null);

	const scheduler = renderer.scheduler as unknown as { _update(): void };
	Ticker.system.remove(scheduler._update, scheduler);
	const timer = setInterval(() => scheduler._update(), 1_000);
	return () => clearInterval(timer);
}
