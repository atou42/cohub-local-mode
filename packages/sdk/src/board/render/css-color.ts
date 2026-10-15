import { DOMAdapter, type ICanvas } from "pixi.js";

export type BoardCssPaint = { color: number; alpha: number };
const cache = new Map<string, BoardCssPaint | null>();
let canvas: ICanvas | null = null;

export function parseBoardCssPaint(value: string): BoardCssPaint | null {
  const key = value.trim();
  if (!key) return null;
  if (key.toLowerCase() === "transparent") return { color: 0, alpha: 0 };
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(key)?.[1];
  if (hex) {
    const digits = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
    return { color: Number.parseInt(digits.slice(0, 6), 16), alpha: digits.length === 8 ? Number.parseInt(digits.slice(6), 16) / 255 : 1 };
  }
  if (cache.has(key)) return cache.get(key) ?? null;
  let result: BoardCssPaint | null = null;
  try {
    canvas ??= DOMAdapter.get().createCanvas(1, 1);
    const context = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    context.fillStyle = "#010203";
    context.fillStyle = key;
    const first = context.fillStyle;
    context.fillStyle = "#040506";
    context.fillStyle = key;
    if (first === context.fillStyle) {
      context.clearRect(0, 0, 1, 1);
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
      result = { color: (r << 16) | (g << 8) | b, alpha: a / 255 };
    }
  } catch {
    result = null;
  }
  if (cache.size >= 256) cache.clear();
  cache.set(key, result);
  return result;
}

export function parseBoardCssColor(value: string): number | null {
  return parseBoardCssPaint(value)?.color ?? null;
}
