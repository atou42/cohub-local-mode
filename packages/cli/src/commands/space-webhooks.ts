import { joinApiUrl, resolveApiBaseUrl } from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { error, handleHttp, json as outJson, jsonRequested, ok, table } from "../output.js";
import { resolveSpace } from "../space.js";

type WebhookOptions = { json?: boolean; secret?: string; body?: string };

export function parseBody(raw: string | undefined): unknown {
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return error("Invalid body", "--body must be JSON");
  }
}

/** `cohub spaces webhooks` — inbound HTTP triggers declared by `.cohub/hooks/<name>` with `on.event: webhook`. */
export function registerSpaceWebhooks(spacesCmd: Command, deps: { createClient?: typeof createClient } = {}): void {
  const client = () => (deps.createClient ?? createClient)();
  const webhooksCmd = spacesCmd
    .command("webhooks")
    .description("Inbound webhooks declared by .cohub/hooks/<name> (on.event: webhook)");

  webhooksCmd
    .command("ls")
    .alias("list")
    .description("List declared webhooks")
    .option("--json", "Output as JSON")
    .action(async (opts: WebhookOptions) => {
      const spaceId = await resolveSpace(spacesCmd);
      try {
        const result = await client().space(spaceId).webhooks.list();
        if (jsonRequested(opts)) return outJson(result.items);
        table(result.items, [
          { key: "name", label: "Name" },
          { key: "action", label: "Action" },
          { key: "hasSecret", label: "Secret" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  webhooksCmd
    .command("url <name>")
    .description("Print the URL external services should POST to")
    .option("--json", "Output as JSON")
    .action(async (name: string, opts: WebhookOptions) => {
      const spaceId = await resolveSpace(spacesCmd);
      const sdk = client();
      const url = joinApiUrl(resolveApiBaseUrl({}), sdk.space(spaceId).webhooks.path(name));
      if (jsonRequested(opts)) return outJson({ name, url });
      process.stdout.write(`${url}\n`);
    });

  webhooksCmd
    .command("trigger <name>")
    .description("POST a JSON body to a webhook hook (local testing)")
    .option("--body <json>", "JSON body", "null")
    .option("--secret <secret>", "Value for on.secret")
    .option("--json", "Output as JSON")
    .action(async (name: string, opts: WebhookOptions) => {
      const spaceId = await resolveSpace(spacesCmd);
      const body = parseBody(opts.body);
      try {
        const result = await client().space(spaceId).webhooks.trigger(name, body, { secret: opts.secret });
        if (jsonRequested(opts)) return outJson(result);
        ok(`Triggered ${result.hook} — task ${result.taskRunId}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}
