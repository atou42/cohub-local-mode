export type RuntimeHarness = "pi" | "codex";
export type SessionHarness = RuntimeHarness | "grok_build" | "cursor";

export type HarnessRoute =
  | { kind: "runtime"; harness: RuntimeHarness }
  | { kind: "session"; harness: SessionHarness };

function explicitRuntimeHarness(meta: unknown): RuntimeHarness | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const harness = (meta as { harness?: unknown }).harness;
  return harness === "pi" || harness === "codex" ? harness : null;
}

/** Turn metadata selects Runtime only when it explicitly names a Runtime harness. */
export function resolveHarnessRoute(
  meta: unknown,
  sessionHarness: SessionHarness = "pi",
): HarnessRoute {
  const runtimeHarness = explicitRuntimeHarness(meta);
  return runtimeHarness
    ? { kind: "runtime", harness: runtimeHarness }
    : { kind: "session", harness: sessionHarness };
}
