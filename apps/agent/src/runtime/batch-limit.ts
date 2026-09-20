import { RUNTIME_MAX_BATCH_INPUT_BYTES, RUNTIME_MAX_BATCH_MESSAGES } from "@cohub/protocol";

/**
 * Bound one claim so a single Runtime execution stays inside the transfer budget.
 * A single oversized input cannot be split further; the transport reports that clearly.
 */
export function limitBatchSize<T>(
  turns: T[],
  sizeOf: (turn: T) => number,
  limits: { messages: number; bytes: number } = { messages: RUNTIME_MAX_BATCH_MESSAGES, bytes: RUNTIME_MAX_BATCH_INPUT_BYTES },
): T[] {
  const batch: T[] = [];
  let bytes = 0;
  for (const turn of turns) {
    if (batch.length >= limits.messages) break;
    const size = sizeOf(turn);
    if (batch.length > 0 && bytes + size > limits.bytes) break;
    batch.push(turn);
    bytes += size;
  }
  return batch.length ? batch : turns.slice(0, 1);
}
