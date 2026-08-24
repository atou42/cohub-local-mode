import { timingSafeEqual } from "node:crypto";

type ManagedRelayTokenInput = {
  nodeOrigin: "cloud" | "local";
  expectedToken: string | null | undefined;
  providedToken: string | null | undefined;
};

export function isManagedLocalSandboxRelayToken(
  input: ManagedRelayTokenInput,
) {
  if (input.nodeOrigin !== "local") return false;
  const expected = input.expectedToken?.trim();
  const provided = input.providedToken?.trim();
  if (!expected || !provided) return false;
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return (
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes)
  );
}
