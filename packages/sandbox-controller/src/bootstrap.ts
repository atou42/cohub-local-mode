import type { SandboxBootstrapGate } from "@cohub/protocol/sandbox";

/** Missing metadata is a legacy Space; malformed/new bootstrap states fail closed. */
export function getSandboxBootstrapGate(meta: unknown): SandboxBootstrapGate {
  if (!meta || typeof meta !== "object" || !("bootstrap" in meta)) return { status: "ready" };
  const bootstrap = meta.bootstrap;
  if (!bootstrap || typeof bootstrap !== "object" || !("status" in bootstrap)) return { status: "waiting" };
  if (bootstrap.status === "ready") return { status: "ready" };
  if (bootstrap.status === "failed") return { status: "failed" };
  return { status: "waiting" };
}
