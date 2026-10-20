import { OutboundDeliveryUnknownError } from "./providers/base.js";

export type OutboundProgressStore = {
  get: (itemId: string) => Promise<string | null>;
  set: (itemId: string, value: string) => Promise<unknown>;
  delete: (itemId: string) => Promise<unknown>;
};

export const createOutboundCheckpoint = (store: OutboundProgressStore, signal: AbortSignal) => async <T, P = undefined>(itemId: string, send: (prepared: P) => Promise<T>, prepare?: () => Promise<P>): Promise<T> => {
  signal.throwIfAborted();
  const stored = await store.get(itemId);
  if (stored) {
    const state = JSON.parse(stored) as { status: string; result?: T };
    if (state.status === "done") return state.result as T;
    throw new OutboundDeliveryUnknownError(`Delivery outcome unknown for item ${itemId}`);
  }
  const prepared = prepare ? await prepare() : undefined as P;
  signal.throwIfAborted();
  await store.set(itemId, JSON.stringify({ status: "sending" }));
  let started = false;
  let result: T;
  try {
    signal.throwIfAborted();
    started = true;
    result = await send(prepared);
  } catch (error) {
    if (!started || (!signal.aborted && !(error instanceof OutboundDeliveryUnknownError))) await store.delete(itemId);
    throw error;
  }
  await store.set(itemId, JSON.stringify({ status: "done", result }));
  return result;
};
