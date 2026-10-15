import type { BoardDocument } from "@neta-art/cohub/board";
import { parseBoardDocument } from "@neta-art/cohub/board";

export const GALLERY_ASSET_PREFIX = "dev/";

const image = (name: string, width: number, height: number) => ({
	src: `${GALLERY_ASSET_PREFIX}img/${name}`,
	snapshot: {
		title: name,
		naturalWidth: width,
		naturalHeight: height,
		mimeType: "image/webp",
	},
});

const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

function galleryItems(): Record<string, unknown> {
	return {
		title: {
			type: "text",
			position: { x: 0, y: -96 },
			props: { text: "Board gallery", fontSize: 32 },
		},
		media: {
			type: "frame",
			position: { x: 0, y: 0 },
			size: { width: 1180, height: 420 },
			props: { label: "Media" },
		},
		castle: {
			type: "image",
			parent: "media",
			position: { x: 32, y: 40 },
			size: { width: 320, height: 180 },
			props: image("hp-arrival.webp", 1280, 720),
		},
		luna: {
			type: "image",
			parent: "media",
			position: { x: 384, y: 40 },
			size: { width: 150, height: 210 },
			props: image("luna.webp", 512, 720),
		},
		forest: {
			type: "image",
			parent: "media",
			position: { x: 566, y: 40 },
			size: { width: 210, height: 210 },
			props: image("hp-forest.webp", 1024, 1024),
		},
		clip: {
			type: "video",
			parent: "media",
			position: { x: 808, y: 40 },
			size: { width: 340, height: 192 },
			props: {
				src: `${GALLERY_ASSET_PREFIX}video/arrival.mp4`,
				snapshot: {
					title: "arrival.mp4",
					durationMs: 6000,
					naturalWidth: 640,
					naturalHeight: 360,
				},
			},
		},
		track: {
			type: "audio",
			parent: "media",
			position: { x: 32, y: 284 },
			size: { width: 340, height: 96 },
			props: {
				src: `${GALLERY_ASSET_PREFIX}audio/cloud-library.mp3`,
				snapshot: { title: "Cloud library.mp3", durationMs: 16000 },
			},
		},
		missing: {
			type: "image",
			parent: "media",
			position: { x: 404, y: 284 },
			size: { width: 160, height: 100 },
			props: image("missing.webp", 160, 100),
		},
		docs: {
			type: "frame",
			position: { x: 0, y: 480 },
			size: { width: 1180, height: 340 },
			props: { label: "Files and tasks" },
		},
		guide: {
			type: "file",
			parent: "docs",
			position: { x: 32, y: 40 },
			size: { width: 260, height: 240 },
			props: {
				src: `${GALLERY_ASSET_PREFIX}docs/guide.html`,
				snapshot: {
					title: "Orientation guide",
					mimeType: "text/html",
					coverPath: `${GALLERY_ASSET_PREFIX}img/cover-guide.png`,
					size: 48_210,
					excerpt: "Houses, timetables and the map of the castle.",
				},
			},
		},
		notes: {
			type: "file",
			parent: "docs",
			position: { x: 324, y: 40 },
			size: { width: 240, height: 160 },
			props: {
				src: `${GALLERY_ASSET_PREFIX}docs/notes.md`,
				snapshot: {
					title: "Sorting notes",
					mimeType: "text/markdown",
					size: 2_140,
					excerpt:
						"New students line up in the great hall, put on the old hat and hear the name of their house.",
				},
			},
		},
		archive: {
			type: "file",
			parent: "docs",
			position: { x: 324, y: 220 },
			size: { width: 240, height: 80 },
			props: {
				src: `${GALLERY_ASSET_PREFIX}docs/archive.zip`,
				snapshot: {
					title: "archive.zip",
					mimeType: "application/zip",
					size: 9_400_000,
				},
			},
		},
		running: {
			type: "task",
			parent: "docs",
			position: { x: 596, y: 40 },
			size: { width: 260, height: 160 },
			props: {
				taskRunId: "dev-running",
				snapshot: {
					taskType: "generation",
					status: "running",
					title: "Forest guardian",
					model: "image-model",
					promptExcerpt: "A glowing stag in a dark forest",
					artifactCount: 0,
					artifacts: [],
					startedAt: iso(-42_000),
				},
			},
		},
		done: {
			type: "task",
			parent: "docs",
			position: { x: 888, y: 40 },
			size: { width: 260, height: 160 },
			props: {
				taskRunId: "dev-done",
				snapshot: {
					taskType: "generation",
					status: "completed",
					title: "Opening line",
					model: "text-model",
					artifactCount: 1,
					artifacts: [
						{
							id: "a",
							type: "text",
							textExcerpt:
								"Past midnight, a page turns somewhere behind the shelves — as if someone has been waiting for you.",
						},
					],
					updatedAt: iso(-60_000),
				},
			},
		},
		queued: {
			type: "task",
			parent: "docs",
			position: { x: 596, y: 220 },
			size: { width: 260, height: 90 },
			props: {
				taskRunId: "dev-queued",
				snapshot: {
					taskType: "generation",
					status: "pending",
					title: "Great hall",
					artifactCount: 0,
					artifacts: [],
				},
			},
		},
		failed: {
			type: "task",
			parent: "docs",
			position: { x: 888, y: 220 },
			size: { width: 260, height: 90 },
			props: {
				taskRunId: "dev-failed",
				snapshot: {
					taskType: "generation",
					status: "failed",
					title: "Library",
					errorExcerpt: "The model rejected the prompt.",
					artifactCount: 0,
					artifacts: [],
				},
			},
		},
		ideas: {
			type: "frame",
			position: { x: 0, y: 880 },
			size: { width: 1180, height: 300 },
			props: { label: "Shapes and links" },
		},
		note: {
			type: "text",
			parent: "ideas",
			position: { x: 32, y: 40 },
			props: { text: "Plain text sits directly on the canvas.", fontSize: 18 },
		},
		hat: {
			type: "shape",
			parent: "ideas",
			position: { x: 32, y: 150 },
			size: { width: 180, height: 96 },
			props: { geometry: "rounded", text: "Sorting" },
		},
		hall: {
			type: "shape",
			parent: "ideas",
			position: { x: 300, y: 150 },
			size: { width: 180, height: 96 },
			style: { stroke: "blue", fill: "blue", fillOpacity: 0.12 },
			props: { geometry: "rectangle", text: "Great hall" },
		},
		wind: {
			type: "shape",
			parent: "ideas",
			position: { x: 568, y: 140 },
			size: { width: 140, height: 116 },
			style: { stroke: "amber" },
			props: { geometry: "ellipse", text: "Wind" },
		},
		cloak: {
			type: "shape",
			parent: "ideas",
			position: { x: 796, y: 140 },
			size: { width: 140, height: 116 },
			style: { stroke: "violet", dash: "dashed" },
			props: { geometry: "diamond", text: "Cloak" },
		},
		link1: {
			type: "arrow",
			parent: "ideas",
			props: {
				start: { item: "hat" },
				end: { item: "hall" },
				label: "leads to",
			},
		},
		link2: {
			type: "arrow",
			parent: "ideas",
			style: { dash: "dashed" },
			props: {
				start: { item: "hall" },
				end: { item: "wind" },
				route: "orthogonal",
			},
		},
		link3: {
			type: "arrow",
			parent: "ideas",
			props: {
				start: { item: "wind" },
				end: { item: "cloak" },
				route: "curve",
				bend: 0.3,
			},
		},
		scribble: {
			type: "draw",
			parent: "ideas",
			style: { stroke: "rose", strokeWidth: 4 },
			props: {
				points: [
					{ x: 1000, y: 160, p: 0.5 },
					{ x: 1040, y: 200, p: 0.6 },
					{ x: 1080, y: 150, p: 0.5 },
					{ x: 1120, y: 220, p: 0.4 },
				],
			},
		},
		web: {
			type: "file",
			position: { x: 1240, y: 0 },
			size: { width: 300, height: 420 },
			props: {
				src: "https://example.com/",
				snapshot: { title: "example.com", mimeType: "text/html" },
			},
		},
	};
}

function benchItems(count: number): Record<string, unknown> {
	const items: Record<string, unknown> = {};
	const columns = Math.ceil(Math.sqrt(count));
	const names = [
		"hp-arrival.webp",
		"luna.webp",
		"hp-forest.webp",
		"hp-library.webp",
	];
	for (let index = 0; index < count; index += 1) {
		const x = (index % columns) * 240;
		const y = Math.floor(index / columns) * 200;
		const kind = index % 4;
		items[`n${index}`] =
			kind === 0
				? {
						type: "image",
						position: { x, y },
						size: { width: 200, height: 150 },
						props: image(names[index % names.length] as string, 1024, 768),
					}
				: kind === 1
					? {
							type: "shape",
							position: { x, y },
							size: { width: 200, height: 150 },
							props: { geometry: "rounded", text: `Card ${index}` },
						}
					: kind === 2
						? {
								type: "file",
								position: { x, y },
								size: { width: 200, height: 150 },
								props: {
									src: `${GALLERY_ASSET_PREFIX}docs/n${index}.md`,
									snapshot: {
										title: `Note ${index}`,
										mimeType: "text/markdown",
										excerpt: "A short excerpt to measure text layout.",
									},
								},
							}
						: {
								type: "text",
								position: { x, y },
								props: { text: `Text ${index}`, fontSize: 20 },
							};
	}
	return items;
}

export function boardGalleryDocument(
	options: { bench?: number } = {},
): BoardDocument {
	const items = options.bench ? benchItems(options.bench) : galleryItems();
	const parsed = parseBoardDocument({ board: {}, items, animations: {} });
	if (!parsed.ok)
		throw new Error(
			parsed.diagnostics
				.map((entry) => `${entry.path}: ${entry.message}`)
				.join("; "),
		);
	return parsed.document;
}
