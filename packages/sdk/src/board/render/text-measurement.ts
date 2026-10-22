import { clearCache, layoutWithLines, type PreparedTextWithSegments, prepareWithSegments } from "@chenglou/pretext";
import { type BoardTextFont, type BoardTextLines, clampBoardFontSize, setBoardTextLayouter } from "@cohub/protocol";
import { BOARD_FONT_STACK, BOARD_MONO_FONT_STACK } from "@cohub/protocol/board-constants";
import { CanvasTextMetrics, DOMAdapter, fontStringFromTextStyle, type TextStyle } from "pixi.js";
import { boardFontFamily } from "../model/text-metrics.js";

export const BOARD_FONT_STACKS = {
  sans: BOARD_FONT_STACK,
  serif: 'ui-serif, Georgia, "Noto Serif CJK SC", "Songti SC", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Noto Sans Math", "DejaVu Sans", "Noto Sans CJK SC", "FreeSans", "FreeSerif", sans-serif',
  mono: BOARD_MONO_FONT_STACK,
};

export type BoardTextStyle = { fontFamily: string; fontSize: number; fontWeight: string };

const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"]);
const QUOTED = /^(["']).+\1$/;
const familyLists = new Map<string, string>();

export function canvasFontFamily(families: string): string {
  let list = familyLists.get(families);
  if (list === undefined) {
    list = families
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => (QUOTED.test(name) || GENERIC_FAMILIES.has(name) ? name : `"${name}"`))
      .join(", ");
    familyLists.set(families, list);
  }
  return list;
}

export function boardTextStyle({ font, fontSize, fontWeight }: BoardTextFont): BoardTextStyle {
  return {
    fontFamily: canvasFontFamily(boardFontFamily(font, BOARD_FONT_STACKS)),
    fontSize: clampBoardFontSize(fontSize),
    fontWeight: String(Math.round(fontWeight / 100) * 100),
  };
}

export function canvasFont({ fontFamily, fontSize, fontWeight }: BoardTextStyle): string {
  return `${fontWeight} ${fontSize}px ${fontFamily}`;
}

const PREPARED_LIMIT = 256;
const prepared = new Map<string, PreparedTextWithSegments>();
const measuredFonts = new Set<string>();
const measuredFamilies = new Set<string>();
const TRAILING_SPACE = /[ \t]+$/u;
const unquote = (name: string) => name.trim().replace(/^["']|["']$/gu, "");

function prepareText(text: string, font: string): PreparedTextWithSegments {
  const key = `${font}\n${text}`;
  let value = prepared.get(key);
  if (value) {
    prepared.delete(key);
    prepared.set(key, value);
    return value;
  }
  if (!measuredFonts.has(font)) {
    measuredFonts.add(font);
    for (const name of /px\s+(.+)$/u.exec(font)?.[1]?.split(",") ?? []) measuredFamilies.add(unquote(name));
  }
  value = prepareWithSegments(text, font, { whiteSpace: "pre-wrap" });
  if (prepared.size >= PREPARED_LIMIT) prepared.delete(prepared.keys().next().value as string);
  prepared.set(key, value);
  return value;
}

export function layoutTextLines(text: string, font: string, maxWidth = Number.POSITIVE_INFINITY): BoardTextLines {
  const lines: string[] = [];
  let width = 0;
  for (const paragraph of text.replace(/\r\n?/gu, "\n").replaceAll("\t", " ").split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    const wrapped = layoutWithLines(prepareText(paragraph, font), maxWidth, 1).lines;
    for (const [index, line] of wrapped.entries()) {
      lines.push(index === wrapped.length - 1 ? line.text : line.text.replace(TRAILING_SPACE, ""));
      width = Math.max(width, line.width);
    }
  }
  return { lines, width };
}

const baselineShifts = new Map<string, number>();

export function cssBaselineShift(style: TextStyle): number {
  const font = fontStringFromTextStyle(style);
  let shift = baselineShifts.get(font);
  if (shift === undefined) {
    const ink = CanvasTextMetrics.measureFont(font);
    const context = DOMAdapter.get().createCanvas(1, 1).getContext("2d") as CanvasRenderingContext2D | null;
    shift = 0;
    if (context) {
      context.font = font;
      const { fontBoundingBoxAscent: ascent, fontBoundingBoxDescent: descent } = context.measureText("M");
      if (Number.isFinite(ascent) && Number.isFinite(descent)) shift = (ascent - descent - (ink.ascent - ink.descent)) / 2;
    }
    baselineShifts.set(font, shift);
  }
  return shift;
}

const layoutBoardLines = (text: string, font: BoardTextFont, maxWidth: number | undefined) =>
  layoutTextLines(text, canvasFont(boardTextStyle(font)), maxWidth);

const canMeasure = () => typeof OffscreenCanvas !== "undefined" || typeof document !== "undefined";

let installed = false;
let fontsChanged = false;
const fontListeners = new Set<() => void>();

function notifyFontsChanged() {
  fontsChanged = false;
  installBoardTextMeasurement();
  for (const listener of fontListeners) listener();
}

export function installBoardTextMeasurement(): void {
  installed = true;
  prepared.clear();
  baselineShifts.clear();
  clearCache();
  CanvasTextMetrics.clearMetrics();
  setBoardTextLayouter(canMeasure() ? layoutBoardLines : undefined);
}

export function ensureBoardTextMeasurement(): void {
  if (installed) return;
  installBoardTextMeasurement();
  globalThis.document?.fonts?.addEventListener("loadingdone", (event) => {
    if (fontsChanged || !event.fontfaces.some((face) => measuredFamilies.has(unquote(face.family)))) return;
    fontsChanged = true;
    requestAnimationFrame(notifyFontsChanged);
  });
}

export function onBoardTextFontsChange(listener: () => void): () => void {
  fontListeners.add(listener);
  return () => fontListeners.delete(listener);
}
