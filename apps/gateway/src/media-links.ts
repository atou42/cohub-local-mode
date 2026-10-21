import type { ContentBlock } from "@cohub/protocol/core";
import type { GatewayMediaItem } from "@cohub/protocol/gateway";

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)]\((https?:\/\/[^\s)]+)\)/g;
const MARKDOWN_LINK_RE = /(?<!!)\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL_RE = /https?:\/\/[^\s<>)"']+/g;

const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const videoExtensions = new Set(["mp4", "mov", "webm", "m4v"]);
const audioExtensions = new Set(["mp3", "m4a", "wav", "ogg", "opus"]);
const fileExtensions = new Set(["pdf", "zip", "txt", "md", "markdown", "json", "csv"]);

const extensionMediaTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4v: "video/mp4",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/opus",
  pdf: "application/pdf",
  zip: "application/zip",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  csv: "text/csv",
};

export const normalizeMediaUrl = (value: string) => value.trim().replace(/[.,;:!?]+$/g, "");

const getExtension = (value: string) => {
  try {
    const path = new URL(value).pathname;
    const name = path.split("/").pop() ?? "";
    const extension = name.includes(".") ? name.split(".").pop()?.toLowerCase() : "";
    return extension ?? "";
  } catch {
    return "";
  }
};

export const isVideoUrl = (url: string) => videoExtensions.has(getExtension(url));

const inferKind = (url: string): GatewayMediaItem["kind"] | null => {
  const extension = getExtension(url);
  if (imageExtensions.has(extension)) return "image";
  if (videoExtensions.has(extension)) return "video";
  if (audioExtensions.has(extension)) return "voice";
  if (fileExtensions.has(extension)) return "file";
  return null;
};

const inferFilename = (url: string, kind: GatewayMediaItem["kind"]) => {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "").trim();
    if (name) return name.slice(0, 180);
  } catch {}
  return `${kind}-${Date.now()}`;
};

const inferMediaType = (url: string) => extensionMediaTypes[getExtension(url)];

function pushMedia(
  mediaItems: GatewayMediaItem[],
  seenUrls: Set<string>,
  urlValue: string,
  options: { forceKind?: GatewayMediaItem["kind"]; maxItems: number },
) {
  const url = normalizeMediaUrl(urlValue);
  if (seenUrls.has(url) || mediaItems.length >= options.maxItems) return;
  const kind = options.forceKind ?? inferKind(url);
  if (!kind) return;
  seenUrls.add(url);
  mediaItems.push({
    kind,
    source: { type: "url", url },
    filename: inferFilename(url, kind),
    mediaType: inferMediaType(url),
  });
}

export function extractMediaLinks(content: ContentBlock[], options: { maxItems?: number } = {}) {
  const maxItems = options.maxItems ?? 4;
  const mediaItems: GatewayMediaItem[] = [];
  const seenUrls = new Set<string>();

  for (const block of content) {
    if (block.type === "image" && block.source.type === "url") {
      pushMedia(mediaItems, seenUrls, block.source.url, { forceKind: "image", maxItems });
      continue;
    }
    if (block.type !== "text") continue;

    for (const match of block.text.matchAll(MARKDOWN_IMAGE_RE)) {
      if (match[2]) pushMedia(mediaItems, seenUrls, match[2], { forceKind: "image", maxItems });
    }
    for (const match of block.text.matchAll(MARKDOWN_LINK_RE)) {
      if (match[2]) pushMedia(mediaItems, seenUrls, match[2], { maxItems });
    }
    for (const match of block.text.matchAll(BARE_URL_RE)) {
      if (match[0]) pushMedia(mediaItems, seenUrls, match[0], { maxItems });
    }
  }

  return mediaItems;
}
