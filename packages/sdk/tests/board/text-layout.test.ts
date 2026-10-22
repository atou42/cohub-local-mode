import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Text } from "pixi.js";
import { layoutBoardText } from "@cohub/protocol";
import { type BoardNodeRenderer, createNodeBoardRenderer } from "../../src/board/export/node/index.js";
import { buildFallbackShapeColors } from "../../src/board/model/index.js";
import {
	type BoardRenderContext,
	DEFAULT_BOARD_RENDER_LABELS,
	defaultBoardPalette,
	defaultBoardRenderStyle,
	getBoardCardRenderer,
	layoutTextLines,
} from "../../src/board/render/index.js";
import { boardScene } from "./fixtures.js";

let available = true;
try {
	await import("@napi-rs/canvas");
} catch {
	available = false;
}

const FONT = '400 18px "Noto Sans CJK SC", sans-serif';
const STORY =
	"联邦学生会长失踪的那天，基沃托斯的天空没有塌下来——只是所有学园的枪口，同时失去了方向。一个没有成年人的学园都市，把最后一份权限交给了一位刚下电车的大人。";

describe("board text layout", { skip: available ? false : "@napi-rs/canvas is not installed" }, () => {
	let renderer: BoardNodeRenderer;
	before(async () => {
		renderer = await createNodeBoardRenderer();
	});
	after(() => renderer?.destroy());

	test("keeps CJK punctuation attached and continues after an em dash", () => {
		const { lines } = layoutTextLines(STORY, FONT, 690);
		assert.ok((lines[0]?.indexOf("——") ?? -1) + 2 < (lines[0]?.length ?? 0), lines.join("\n"));
		const punctuation = "“你好，”他说：「今天（周三）下雨。」……然后呢？！《三体》第二部、第三部都很好看；推荐【必读】。";
		for (let width = 60; width <= 420; width += 7) {
			for (const line of layoutTextLines(punctuation, FONT, width).lines)
				assert.doesNotMatch(line, /^[，。、；：？！）」』》】”]/u, `${width}: ${line}`);
		}
	});

	test("draws the computed lines and hides canvas text while editing", () => {
		const props = { text: STORY, width: 300, fontSize: 18 };
		const scene = boardScene({ t: { type: "text", props }, typing: { type: "text", props: { ...props, reveal: 0.4 } } });
		const context = renderContext(scene);
		const draw = (id: string) => {
			const item = scene.get(id);
			assert.ok(item);
			const container = getBoardCardRenderer(item, context).create(item, context);
			return container.children[0] as Text;
		};
		const layout = layoutBoardText(scene.get("t")?.props as Parameters<typeof layoutBoardText>[0]);
		const body = draw("t");
		assert.equal(body.text, layout.lines.join("\n"));
		assert.equal(body.style.wordWrap, false);
		assert.equal(body.visible, true);
		const typed = draw("typing").text.split("\n");
		for (const [index, line] of typed.entries()) assert.ok(layout.lines[index]?.startsWith(line));
		context.editingId = "t";
		assert.equal(draw("t").visible, false);
	});
});

function renderContext(scene: ReturnType<typeof boardScene>): BoardRenderContext {
	return {
		settings: {} as BoardRenderContext["settings"],
		scene,
		time: 0,
		selectedIds: new Set(),
		hoveredId: null,
		resizingIds: new Set(),
		liftedIds: new Set(),
		palette: defaultBoardPalette("light"),
		colors: buildFallbackShapeColors("light"),
		colorScheme: "light",
		style: defaultBoardRenderStyle("light"),
		themeKey: "test",
		rendererType: "canvas",
		zoom: 1,
		textResolution: 1,
		reducedMotion: true,
		labels: DEFAULT_BOARD_RENDER_LABELS,
		taskRun: () => null,
		assetKey: () => null,
		getTexture: () => null,
		hasError: () => false,
		fileState: () => "ok",
		acquireTexture: () => {},
		releaseTexture: () => {},
	};
}
