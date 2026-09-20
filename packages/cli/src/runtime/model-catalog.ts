import type { RuntimeCapabilities } from "@neta-art/cohub";
import { record, type JsonRecord } from "./json-rpc.js";

type Model = RuntimeCapabilities["models"][number];

/** Codex's built-in catalog is not authoritative for an arbitrary custom provider. */
export function codexModelCatalog(configResponse: JsonRecord, entries: unknown[]): Model[] {
  const config = record(configResponse.config);
  const provider = typeof config.model_provider === "string" ? config.model_provider : "openai";
  const configuredModel = typeof config.model === "string" ? config.model : null;
  const customCatalog = typeof config.model_catalog_json === "string";
  const catalog = provider !== "openai" && !customCatalog ? [] : entries;
  const models: Model[] = catalog.flatMap((value) => {
    const model = record(value);
    const id = typeof model.model === "string" ? model.model : typeof model.id === "string" ? model.id : null;
    if (!id || model.hidden) return [];
    return [{ harness: "codex", provider, id, name: typeof model.displayName === "string" ? model.displayName : id }];
  });
  if (configuredModel && !models.some((model) => model.id === configuredModel)) models.unshift({ harness: "codex", provider, id: configuredModel, name: configuredModel });
  return models;
}
