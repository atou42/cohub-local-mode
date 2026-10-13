
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, copyFile, link, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const execFile = promisify(execFileCallback);
import { parseBoardMediaSource } from "@neta-art/cohub/board";
import type { BoardDocument, BoardExportRegion, BoardSceneItem } from "@neta-art/cohub/board";
import type {
  BoardNodeExportFormat,
  BoardNodeFont,
  BoardNodeRenderer,
  BoardNodeTexture,
} from "@neta-art/cohub/board/export/node";
import {
  hasBoardScripts,
  boardDocumentAt,
  createBoardRenderSampler,
  boardImageKeySource,
  buildBoardScene,
  createNodeBoardRenderer,
  createNodeBoardScriptHost,
  exportBoardImageBytes,
  imageAssetKey,
  parseBoardDocument,
  planBoardExport,
  prepareBoardExport,
  selectBoardExportAssets,
} from "./board-kernel.js";
import { resolveBoardId } from "./board-command-support.js";
import { BOARD_EXPORT_FONTS, type BoardExportFont } from "./board-fonts.js";
import { createClient } from "./client.js";
import { downloadPublicAudio, downloadPublicImage } from "./safe-remote-image.js";

export function resolveBundledFonts(): BoardNodeFont[] {
  const require = createRequire(import.meta.url);
  const bundled = fileURLToPath(new URL("./fonts/", import.meta.url));
  const locate = ({ pkg, file }: BoardExportFont): string | null => {
    const copied = join(bundled, file);
    if (existsSync(copied)) return copied;
    try {
      const path = join(dirname(require.resolve(`${pkg}/package.json`)), "files", file);
      return existsSync(path) ? path : null;
    } catch {
      return null;
    }
  };
  return BOARD_EXPORT_FONTS.flatMap((font) => {
    const path = locate(font);
    return path ? [{ path, family: font.family }] : [];
  });
}

export type BoardExportSource = {
  document: BoardDocument;
  boardId: string;
  title: string | null;
};

export async function loadBoardDocument(
  spaceId: string,
  target: string,
): Promise<BoardExportSource> {
  const board = createClient().space(spaceId).board(await resolveBoardId(spaceId, target));
  let result = await board.get();
  const snapshot = result;
  const items = { ...result.items };
  while (result.next) {
    result = await board.get({ only: ["items"], cursor: result.next });
    if (result.version !== snapshot.version) throw new Error("Board changed while reading. Retry the export.");
    Object.assign(items, result.items);
  }
  const parsed = parseBoardDocument({ board: snapshot.board, items, animations: snapshot.animations ?? {} });
  if (!parsed.ok) throw new Error(`Board ${result.id} could not be read: ${parsed.diagnostics[0]?.path}: ${parsed.diagnostics[0]?.message}`);
  return { document: parsed.document, boardId: result.id, title: result.title };
}

export type BoardExportTextureCache = { textures: Map<string, BoardNodeTexture>; failed: Set<string> };

export async function loadBoardTextures(
  renderer: BoardNodeRenderer,
  spaceId: string,
  items: readonly BoardSceneItem[],
  options: { concurrency?: number; cache?: BoardExportTextureCache } = {},
): Promise<{
  textures: Map<string, BoardNodeTexture>;
  failed: string[];
  omitted: string[];
}> {
  const selection = selectBoardExportAssets([...items], imageAssetKey);
  const cache = options.cache ?? { textures: new Map<string, BoardNodeTexture>(), failed: new Set<string>() };
  const { textures, failed } = cache;
  const wanted = new Set(selection.keys);
  for (const [key, texture] of textures) {
    if (wanted.has(key)) continue;
    texture.destroy(true);
    textures.delete(key);
  }
  for (const key of failed) if (!wanted.has(key)) failed.delete(key);
  const pending = selection.keys.filter((key) => !textures.has(key) && !failed.has(key));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 16));
  const client = createClient();

  async function worker() {
    for (;;) {
      const key = pending.shift();
      if (!key) return;
      const source = boardImageKeySource(key);
      if (!source) {
        failed.add(key);
        continue;
      }
      try {
        const { bytes, mimeType } =
          source.kind === "file"
            ? await readSpaceFileBytes(client, spaceId, source.value)
            : await downloadPublicImage(source.value);
        const texture = await renderer.decodeImage(bytes, mimeType);
        textures.set(key, texture);
      } catch {
        failed.add(key);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  return { textures, failed: [...failed], omitted: selection.omittedKeys };
}

async function readSpaceFileBytes(
  client: ReturnType<typeof createClient>,
  spaceId: string,
  path: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const { blob, mimeType } = await client.space(spaceId).files.download(path);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType };
}

export type BoardExportRunOptions = {
  spaceId: string;
  target: string;
  region: BoardExportRegion;
  times?: number[];
  animation?: string;
  scale: number;
  padding?: number;
  colorScheme: "dark" | "light";
  background: "paper" | "transparent";
  format: BoardNodeExportFormat;
  quality?: number;
  withImages: boolean;
  camera?: { width: number; height: number };
  document?: BoardDocument;
  signal?: AbortSignal;
  onFrame?: (frame: BoardExportFrame, index: number) => Promise<void>;
  onProgress?: (completed: number, total: number) => void;
};

export type BoardExportFrame = {
  time: number | null;
  bytes: Uint8Array;
  width: number;
  height: number;
  scale: number;
  itemCount: number;
  format: BoardNodeExportFormat;
};

export type BoardExportRunResult = {
  frames: BoardExportFrame[];
  warnings: string[];
};

export type BoardVideoExportFormat = "mp4" | "webm";

export type BoardVideoExportOptions = Omit<BoardExportRunOptions, "format"> & {
  format: BoardVideoExportFormat;
  fps: number;
  output: string;
  force?: boolean;
};

export async function runBoardVideoExport(options: BoardVideoExportOptions): Promise<{ width: number; height: number; frames: number; warnings: string[] }> {
  if (!options.animation) throw new Error("Video export needs --animation.");
  if (!options.times || options.times.length < 2) throw new Error("Video export needs an --at range with at least two frames.");
  const times = options.times;
  const step = (times[1] as number) - (times[0] as number);
  if (!Number.isFinite(step) || step <= 0) throw new Error("Video export needs an increasing --at range.");
  const derivedFps = 1000 / step;
  if (Math.abs(options.fps - derivedFps) > 0.01) throw new Error(`--fps must match the --at step (${derivedFps.toFixed(3)} fps).`);
  if (times.some((time, index) => index > 0 && Math.abs(time - (times[index - 1] as number) - step) > 0.001)) throw new Error("Video export needs evenly spaced times.");
  await execFile("ffmpeg", ["-version"], { signal: options.signal }).catch(() => { throw new Error("Video export needs ffmpeg. Install ffmpeg and try again."); });
  const document = options.document ?? (await loadBoardDocument(options.spaceId, options.target)).document;
  const tempDir = await mkdtemp(join(tmpdir(), "cohub-board-export-"));
  try {
    let count = 0;
    let dimensions = { width: 0, height: 0 };
    const result = await runBoardExport({ ...options, document, format: "png", onFrame: async (frame, index) => {
      await writeFile(join(tempDir, `${String(index + 1).padStart(6, "0")}.png`), frame.bytes, { signal: options.signal });
      dimensions = { width: frame.width, height: frame.height };
      count++;
    } });
    if (!result || !count) throw new Error("Nothing to export: the region contains no items.");
    const audioDocument = boardDocumentAt(document, options.animation, times[0] as number).document;
    const audio = Object.values(audioDocument.items).filter((item) => item.type === "audio");
    const audioInputs: Array<{ path: string; offset: number }> = [];
    for (const [index, item] of audio.entries()) {
      const source = parseBoardMediaSource(item.props.src);
      if (!source) throw new Error("Invalid board audio source");
      const { bytes } = source.kind === "url"
        ? await downloadPublicAudio(source.value)
        : await readSpaceFileBytes(createClient(), options.spaceId, source.value);
      const path = join(tempDir, `audio-${index}`);
      await writeFile(path, bytes);
      audioInputs.push({ path, offset: Math.max(0, item.props.time ?? 0) / 1000 });
    }
    const duration = Math.max(0.001, count / options.fps);
    const args = ["-y", "-f", "image2", "-framerate", String(options.fps), "-i", join(tempDir, "%06d.png")];
    for (const input of audioInputs) {
      if (input.offset > 0) args.push("-ss", input.offset.toFixed(3));
      args.push("-i", input.path);
    }
    if (audioInputs.length > 1) {
      const inputs = audioInputs.map((_, index) => `[${index + 1}:a]`).join("");
      args.push("-filter_complex", `${inputs}amix=inputs=${audioInputs.length}:duration=longest:dropout_transition=0[aout]`, "-map", "0:v:0", "-map", "[aout]");
    } else {
      args.push("-map", "0:v:0");
      if (audioInputs.length === 1) args.push("-map", "1:a:0");
    }
    if (options.format === "mp4") args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-f", "mp4");
    else args.push("-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-c:a", "libopus", "-f", "webm");
    const encoded = join(tempDir, `video.${options.format}`);
    args.push("-t", duration.toFixed(3), encoded);
    try {
      await execFile("ffmpeg", args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, signal: options.signal });
    } catch (error) {
      const cause = error as { code?: string; stderr?: string; message?: string };
      if (cause.code === "ENOENT") throw new Error("Video export needs ffmpeg. Install ffmpeg and try again.");
      throw new Error(`ffmpeg could not encode the video: ${(cause.stderr ?? cause.message ?? "unknown error").trim().split("\n").slice(-6).join("\n")}`);
    }
    options.signal?.throwIfAborted();
    const staged = `${options.output}.${randomUUID()}.tmp`;
    try {
      await copyFile(encoded, staged, constants.COPYFILE_EXCL);
      options.signal?.throwIfAborted();
      if (options.force) await rename(staged, options.output);
      else await link(staged, options.output);
    } finally { await unlink(staged).catch(() => undefined); }
    return { ...dimensions, frames: count, warnings: result.warnings };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function runBoardExport(
  options: BoardExportRunOptions,
): Promise<BoardExportRunResult | null> {
  options.signal?.throwIfAborted();
  const document = options.document ?? (await loadBoardDocument(options.spaceId, options.target)).document;
  if (options.animation && !document.animations[options.animation]) {
    throw new Error(`Animation ${options.animation} does not exist.`);
  }
  const times: Array<number | null> = options.times?.length ? options.times : [null];
  const renderer = await createNodeBoardRenderer({ fonts: resolveBundledFonts() });
  let scriptHost: ReturnType<typeof createNodeBoardScriptHost> | null = null;
  const textureCache: BoardExportTextureCache = { textures: new Map(), failed: new Set() };
  let backgroundTexture: BoardNodeTexture | undefined;
  try {
    const sampler = createBoardRenderSampler(document, options.animation ?? null, { colorScheme: options.colorScheme });
    const documentAt = (time: number | null) => time === null ? document : sampler.at(time).document;

    const plan = planBoardExport({
      scene: buildBoardScene(documentAt(times[0] ?? null)),
      region: options.region,
      scale: options.scale,
      ...(options.padding === undefined ? {} : { padding: options.padding }),
    });
    if (!plan) return null;

    const warnings: string[] = [];
    const textures = textureCache.textures;
    let omittedKeys = new Set<string>();
    const declaredBackground = document.board.background;
    if (
      options.withImages &&
      options.background === "paper" &&
      declaredBackground.kind === "image" &&
      declaredBackground.imageUrl
    ) {
      try {
        const { bytes, mimeType } = await downloadPublicImage(declaredBackground.imageUrl);
        backgroundTexture = await renderer.decodeImage(bytes, mimeType);
      } catch {
        warnings.push(
          "The board background image could not be loaded; the fallback color was exported.",
        );
      }
    }

    const videoCount = plan.items.filter((item) => item.type === "video").length;
    if (hasBoardScripts(document)) scriptHost = createNodeBoardScriptHost(renderer, {
      readModule: async (src) => {
        const { bytes } = await readSpaceFileBytes(createClient(), options.spaceId, src);
        return new TextDecoder().decode(bytes);
      },
    });
    const region: BoardExportRegion = times.length > 1 && !options.camera ? { kind: "rect", rect: plan.world } : options.region;
    const host = scriptHost;
    if (videoCount > 0) {
      warnings.push(
        `${videoCount} video preview${videoCount === 1 ? " was" : "s were"} drawn as placeholders; video decoding is unavailable in Node.`,
      );
    }

    const backgroundImage = backgroundTexture
      ? { texture: backgroundTexture, fit: declaredBackground.fit ?? "cover", position: "center" as const, opacity: declaredBackground.opacity ?? 1 }
      : undefined;
    const assetKey = options.withImages
      ? (item: BoardSceneItem) => {
          const key = imageAssetKey(item);
          return key && omittedKeys.has(key) ? null : key;
        }
      : undefined;
    const frames: BoardExportFrame[] = [];
    const reported = new Set<string>();
    let completed = 0;
    for (const time of times) {
      options.signal?.throwIfAborted();
      host?.clearFrames();
      const frameOptions = { sampler, camera: options.camera, ...(time === null ? {} : { at: { animation: options.animation, time } }), region, scale: options.scale, padding: times.length > 1 ? 0 : options.padding };
      const initial = prepareBoardExport(document, frameOptions);
      if (!initial) continue;
      let prepared = initial;
      if (host) {
        await host.prepare(initial.scene.items, [time ?? 0], initial.plan.scale);
        for (const item of initial.scene.items) {
          const error = host.error(item.id);
          if (error) throw new Error(`${item.script?.src ?? item.id}: ${error}`);
        }
        const scripted = prepareBoardExport(document, { ...frameOptions, scripts: host });
        if (!scripted) continue;
        prepared = scripted;
      }
      if (options.withImages) {
        const loaded = await loadBoardTextures(renderer, options.spaceId, prepared.plan.items.filter((item) => prepared.scene.opacity(item.id) > 0), { cache: textureCache });
        omittedKeys = new Set(loaded.omitted);
        const assetWarnings = [
          loaded.failed.length ? `${loaded.failed.length} image(s) could not be loaded: ${loaded.failed.slice(0, 3).join(", ")}` : null,
          loaded.omitted.length ? `${loaded.omitted.length} previews were drawn as placeholders to stay within the export texture limit.` : null,
        ];
        for (const warning of assetWarnings) if (warning && !reported.has(warning)) {
          warnings.push(warning);
          reported.add(warning);
        }
      }

      const result = exportBoardImageBytes(renderer, document, {
        ...frameOptions,
        colorScheme: options.colorScheme,
        background: options.background,
        textures,
        scripts: scriptHost ?? undefined,
        backgroundImage,
        ...(assetKey ? { assetKey } : {}),
        format: options.format,
        quality: options.quality,
      });
      if (!result) continue;
      for (const warning of result.warnings) {
        if (warning.kind === "images-missing" && options.withImages) continue;
        const text = describeWarning(warning);
        if (!reported.has(text)) warnings.push(text);
        reported.add(text);
      }
      const frame: BoardExportFrame = {
        time,
        bytes: result.bytes,
        width: result.plan.width,
        height: result.plan.height,
        scale: result.plan.scale,
        itemCount: result.plan.items.length,
        format: result.format,
      };
      if (options.onFrame) await options.onFrame(frame, completed);
      else frames.push(frame);
      completed++;
      options.onProgress?.(completed, times.length);
    }
    return completed ? { frames, warnings } : null;
  } finally {
    scriptHost?.destroy();
    for (const texture of textureCache.textures.values()) texture.destroy(true);
    backgroundTexture?.destroy(true);
    renderer.destroy();
  }
}

function describeWarning(warning: { kind: string; [key: string]: unknown }): string {
  if (warning.kind === "scale-clamped") {
    return `Scale reduced from ${warning.requested}x to ${Number(warning.applied).toFixed(2)}x to stay within the size limit.`;
  }
  if (warning.kind === "images-missing") {
    const keys = warning.keys as string[];
    return `${keys.length} image${keys.length === 1 ? "" : "s"} drawn as placeholders (use --images to fetch them).`;
  }
  if (warning.kind === "many-items") {
    return `${warning.count} items exported.`;
  }
  return warning.kind;
}
