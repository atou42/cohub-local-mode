import type { BoardNodeRenderer } from "@neta-art/cohub/board/export/node";

export const BOARD_EXPORT_IMAGE_MEMORY_MIB = 256;

export class BoardExportResourceError extends Error {}

export function createBoardExportImageBudget(renderer: BoardNodeRenderer, maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Image memory budget must be a positive integer.");
  let usedBytes = 0;
  const decodeImage: BoardNodeRenderer["decodeImage"] = async (bytes, mimeType) => {
    const { default: sharp } = await import("sharp");
    const { width, height } = await sharp(bytes, { limitInputPixels: false }).metadata();
    const required = (width ?? 0) * (height ?? 0) * 4;
    if (!Number.isSafeInteger(required) || required <= 0) throw new Error("Image dimensions could not be read.");
    if (required > maxBytes - usedBytes) {
      throw new BoardExportResourceError(
        `Image ${width}x${height} needs ${Math.ceil(required / 1024 ** 2)} MiB; ` +
        `${Math.ceil(usedBytes / 1024 ** 2)} MiB is already reserved against the ${Math.floor(maxBytes / 1024 ** 2)} MiB image budget. ` +
        "Use smaller source images, export a smaller region, or increase --image-memory if enough memory is available.",
      );
    }
    usedBytes += required;
    try {
      const texture = await renderer.decodeImage(bytes, mimeType);
      const destroy = texture.destroy.bind(texture);
      let released = false;
      texture.destroy = (destroySource) => {
        if (destroySource && !released) {
          released = true;
          usedBytes -= required;
        }
        destroy(destroySource);
      };
      return texture;
    } catch (error) {
      usedBytes -= required;
      throw error;
    }
  };
  return { decodeImage, get usedBytes() { return usedBytes; } };
}
