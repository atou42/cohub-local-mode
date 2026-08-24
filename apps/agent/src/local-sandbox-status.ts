type SandboxStatusRecord = {
  provider?: string | null;
  status?: string | null;
  meta?: unknown;
};

export function managedLocalSandboxError(
  sandbox: SandboxStatusRecord | null | undefined,
) {
  if (sandbox?.provider !== "local" || sandbox.status !== "error") return null;
  const meta =
    typeof sandbox.meta === "object" &&
    sandbox.meta !== null &&
    !Array.isArray(sandbox.meta)
      ? (sandbox.meta as Record<string, unknown>)
      : null;
  if (meta?.managedBy !== "local-mode-supervisor") return null;
  const lastError =
    typeof meta.lastError === "string" ? meta.lastError.trim() : "";
  return new Error(
    `local sandbox failed to start: ${lastError || "unknown supervisor error"}`,
  );
}
