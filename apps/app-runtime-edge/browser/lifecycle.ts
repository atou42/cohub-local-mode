const LIFECYCLE_TYPE = "cohub.runtime.lifecycle";
const LIFECYCLE_VERSION = 1;
const MAX_SUBSCRIPTION_ID_LENGTH = 128;

type LifecycleRequest = {
  type: typeof LIFECYCLE_TYPE;
  version: typeof LIFECYCLE_VERSION;
  action: "subscribe" | "unsubscribe";
  subscriptionId: string;
};

type Milestone = { name: "first-contentful-paint"; startTime: number };
type Subscription = { id: string; origin: string };

function parseRequest(value: unknown): LifecycleRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (
    message.type !== LIFECYCLE_TYPE || message.version !== LIFECYCLE_VERSION ||
    (message.action !== "subscribe" && message.action !== "unsubscribe") ||
    typeof message.subscriptionId !== "string" || !message.subscriptionId.trim() ||
    message.subscriptionId.length > MAX_SUBSCRIPTION_ID_LENGTH
  ) return null;
  return message as LifecycleRequest;
}

function isHttpOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === origin;
  } catch {
    return false;
  }
}

/** A document-local, opt-in channel to the direct embedder, independent of the SDK bridge. */
export function startRuntimeLifecycle(): void {
  if (window.parent === window) return;
  const documentId = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const timeOrigin = performance.timeOrigin;
  const milestones: Milestone[] = [];
  let subscription: Subscription | null = null;
  let observer: PerformanceObserver | undefined;

  const sendState = () => {
    if (!subscription) return;
    try {
      window.parent.postMessage({
        type: LIFECYCLE_TYPE,
        version: LIFECYCLE_VERSION,
        action: "state",
        subscriptionId: subscription.id,
        documentId,
        timeOrigin,
        milestones: milestones.map((milestone) => ({ ...milestone })),
      }, subscription.origin);
    } catch {
      // A detached or navigating parent must not interrupt the App.
    }
  };

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window.parent || !isHttpOrigin(event.origin)) return;
    const request = parseRequest(event.data);
    if (!request) return;
    if (request.action === "subscribe") {
      subscription = { id: request.subscriptionId, origin: event.origin };
      sendState();
    } else if (subscription?.id === request.subscriptionId && subscription.origin === event.origin) {
      subscription = null;
    }
  });

  if (typeof PerformanceObserver === "undefined") return;
  if (Array.isArray(PerformanceObserver.supportedEntryTypes) && !PerformanceObserver.supportedEntryTypes.includes("paint")) return;
  try {
    observer = new PerformanceObserver((list) => {
      if (milestones.length > 0) return;
      const paint = list.getEntries().find((entry) =>
        entry.entryType === "paint" && entry.name === "first-contentful-paint" &&
        Number.isFinite(entry.startTime) && entry.startTime >= 0,
      );
      if (!paint) return;
      milestones.push({ name: "first-contentful-paint", startTime: paint.startTime });
      observer?.disconnect();
      sendState();
    });
    observer.observe({ type: "paint", buffered: true });
  } catch {
    observer?.disconnect();
  }
}
