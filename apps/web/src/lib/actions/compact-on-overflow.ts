import type { Attachment } from "svelte/attachments";

/** Set `data-compact` on a scroll container while its content overflows. */
export const compactOnOverflow: Attachment<HTMLElement> = (node) => {
	let frame = 0;
	const update = () => {
		node.removeAttribute("data-compact");
		node.toggleAttribute("data-compact", node.scrollWidth > node.clientWidth);
	};
	const observer = new ResizeObserver((entries) => {
		cancelAnimationFrame(frame);
		if (entries.some((entry) => entry.target === node)) update();
		else frame = requestAnimationFrame(update);
	});
	observer.observe(node);
	if (node.firstElementChild) observer.observe(node.firstElementChild);
	return () => {
		cancelAnimationFrame(frame);
		observer.disconnect();
	};
};
