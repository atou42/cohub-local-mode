import { SANDBOX_SPECS } from "@cohub/sandbox-controller";
import { SANDBOX_POD_TEMPLATE, validateSandboxPodTemplateVariables, type SandboxPodTemplateVariables } from "./templates/sandbox-pod.js";

type TemplateVars = SandboxPodTemplateVariables;

const replaceInValue = (value: unknown, vars: TemplateVars): unknown => {
  if (typeof value === "string") {
    return value.replace(
      /\$\{([A-Z0-9_]+)\}/g,
      (_, key: string) => {
        const value = vars[key as keyof TemplateVars];
        return value ?? "";
      },
    );
  }

  if (Array.isArray(value)) {
    return value.map((item) => replaceInValue(item, vars));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        replaceInValue(nestedValue, vars),
      ]),
    );
  }

  return value;
};

export const renderSandboxPodTemplate = (vars: TemplateVars) => {
  const validated = validateSandboxPodTemplateVariables(vars);
  const pod = replaceInValue(SANDBOX_POD_TEMPLATE, validated) as Record<string, unknown>;
  const specId = validated.SANDBOX_SPEC_ID ?? "standard";
  const resources = SANDBOX_SPECS[specId]?.resources ?? SANDBOX_SPECS.standard.resources;
  const podSpec = pod.spec as { containers?: Array<{ resources?: unknown; image?: string }> } | undefined;
  if (podSpec?.containers?.[0]) {
    podSpec.containers[0].resources = resources;
    if (validated.SANDBOX_IMAGE) podSpec.containers[0].image = validated.SANDBOX_IMAGE;
  }
  return pod;
};
