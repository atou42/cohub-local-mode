import { UPLOAD_MAX_BATCH_BYTES, UPLOAD_MAX_BATCH_FILES } from "./upload.js";

/**
 * Structured upload rejection codes shared by the api routes and their clients.
 * The api keeps human-readable English messages; clients map these codes to
 * localized copy instead of matching on message text.
 */

/** A single file exceeds `UPLOAD_MAX_FILE_BYTES`. */
export const UPLOAD_ERROR_FILE_TOO_LARGE = "file_too_large" as const;
/** One batch exceeds `UPLOAD_MAX_BATCH_BYTES`. */
export const UPLOAD_ERROR_BATCH_TOO_LARGE = "upload_batch_too_large" as const;
/** One batch exceeds `UPLOAD_MAX_BATCH_FILES`. */
export const UPLOAD_ERROR_TOO_MANY_FILES = "upload_too_many_files" as const;
/** The per-user upload quota is exhausted; the response carries `retryAfterSeconds`. */
export const UPLOAD_ERROR_RATE_LIMITED = "upload_rate_limited" as const;

/**
 * Split entries into batches that respect the batch byte and file caps, keeping
 * input order. A single entry larger than the batch byte cap still gets its own
 * batch so the server can reject it with `file_too_large` rather than silently
 * dropping it.
 */
export function batchUploadEntries<T>(
  entries: readonly T[],
  sizeOf: (entry: T) => number,
  options: { maxBatchBytes?: number; maxBatchFiles?: number } = {},
): T[][] {
  const maxBatchBytes = options.maxBatchBytes ?? UPLOAD_MAX_BATCH_BYTES;
  const maxBatchFiles = options.maxBatchFiles ?? UPLOAD_MAX_BATCH_FILES;
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = 0;
  for (const entry of entries) {
    if (batch.length > 0 && (batch.length >= maxBatchFiles || bytes + sizeOf(entry) > maxBatchBytes)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(entry);
    bytes += sizeOf(entry);
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}
