import { fetchRemoteImage } from "@cohub/infra/safe-fetch";
import { normalizeImage } from "@cohub/media";
import type { DecisionState, DecisionStateImage } from "@cohub/protocol";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { RequestError } from "../lib/request-error.js";

const IMAGE_CONCURRENCY = 4;
const IMAGE_TIMEOUT_MS = 15_000;
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const UPSTREAM_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

type UpstreamImage = { type: "image_url"; image_url: { url: string } };
export type UpstreamDecisionState = string | Record<string, unknown> | Array<string | UpstreamImage>;

const imageUrlOf = (part: DecisionStateImage) =>
  typeof part.image_url === "string" ? part.image_url : part.image_url.url;

export const countStateImages = (state: DecisionState) =>
  Array.isArray(state) ? state.filter((part) => typeof part !== "string").length : 0;

// The upstream Decisions API requires inline data URLs.
export async function prepareDecisionState(
  state: DecisionState,
  options: { signal?: AbortSignal } = {},
): Promise<UpstreamDecisionState> {
  if (!Array.isArray(state)) return state;
  return mapWithConcurrency(state, IMAGE_CONCURRENCY, async (part) => {
    if (typeof part === "string") return part;
    const url = imageUrlOf(part);
    if (url.startsWith("data:")) return { type: "image_url" as const, image_url: { url } };
    return { type: "image_url" as const, image_url: { url: await inlineRemoteImage(url, options.signal) } };
  });
}

async function inlineRemoteImage(url: string, signal?: AbortSignal): Promise<string> {
  if (!/^https?:\/\//i.test(url)) {
    throw new RequestError(400, "invalid_decision_request", "Image URLs must be https or data URLs.", { url });
  }
  let image: Awaited<ReturnType<typeof normalizeImage>>;
  try {
    const remote = await fetchRemoteImage({ url, maxBytes: IMAGE_MAX_BYTES, timeoutMs: IMAGE_TIMEOUT_MS, signal });
    image = await normalizeImage(remote.data, remote.mimeType);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new RequestError(400, "decision_image_unavailable", `Image could not be loaded: ${reason}`, { url });
  }
  if (!UPSTREAM_IMAGE_TYPES.has(image.mimeType)) {
    throw new RequestError(400, "decision_image_unsupported", `Unsupported image type ${image.mimeType}; use PNG, JPEG or WebP.`, { url });
  }
  return `data:${image.mimeType};base64,${image.data.toString("base64")}`;
}
