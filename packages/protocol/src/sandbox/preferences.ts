export type SandboxImageId = "default" | "game";
export type SandboxPreferenceSpec = "standard" | "boost" | "ultra";
export type SandboxPreferences = { image?: SandboxImageId; spec?: SandboxPreferenceSpec };
export type SandboxPreferenceSource = { source: string; preferences: SandboxPreferences; revision?: string; error?: string };
export type SandboxPreferenceStatus = {
  requested: Required<SandboxPreferences>;
  effective: Required<SandboxPreferences>;
  applied: { image: SandboxImageId | null; spec: SandboxPreferenceSpec | null };
  overrides: SandboxPreferences;
  origins: { image: string; spec: string };
  warnings: string[];
  sources: SandboxPreferenceSource[];
  images: SandboxImageId[];
  pendingRestart: boolean;
  applicable: boolean;
};
