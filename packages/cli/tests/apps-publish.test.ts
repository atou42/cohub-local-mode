import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { AppCreateInput, CohubHttpClient } from "@neta-art/cohub";
import { Command } from "commander";
import { registerApps } from "../src/commands/apps.js";

function setup(t: TestContext, executionToken?: string) {
  const previousToken = process.env.COHUB_EXECUTION_TOKEN;
  if (executionToken) process.env.COHUB_EXECUTION_TOKEN = executionToken;
  else delete process.env.COHUB_EXECUTION_TOKEN;
  t.after(() => {
    if (previousToken === undefined) delete process.env.COHUB_EXECUTION_TOKEN;
    else process.env.COHUB_EXECUTION_TOKEN = previousToken;
  });
  const published: AppCreateInput[] = [];
  const errors: string[] = [];
  t.mock.method(console, "log", () => undefined);
  t.mock.method(process.stderr, "write", (chunk: unknown) => {
    errors.push(String(chunk));
    return true;
  });
  t.mock.method(process, "exit", (code: number) => {
    throw new Error(`CLI exit ${code}`);
  });
  const client = {
    apps: {
      create: async (input: AppCreateInput) => {
        published.push(input);
        return { app: { id: "test-app" } };
      },
    },
    publicAssets: {
      createUpload: async () => {
        throw new Error("Port publishing must not upload local files");
      },
    },
  } as unknown as CohubHttpClient;
  const program = new Command("cohub").option("-s, --space <id>");
  registerApps(program, { createClient: () => client });
  const publish = (...options: string[]) =>
    program.parseAsync([
      "node",
      "cohub",
      "--space",
      "test-space",
      "apps",
      "publish",
      "test-port",
      "--port",
      "3000",
      "--json",
      ...options,
    ]);
  return { publish, published, errors };
}

test("local CLI publishes a sandbox port without selecting a file source", async (t) => {
  const { publish, published } = setup(t);
  await publish();
  assert.equal(published.length, 1);
  assert.equal(published[0]?.targetType, "port");
  assert.equal(published[0]?.targetRef, "3000");
  assert.equal(published[0]?.meta?.runtime, undefined);
});

test("sandbox CLI preserves port publishing", async (t) => {
  const { publish, published } = setup(t, "test-execution-context");
  await publish();
  assert.equal(published[0]?.targetType, "port");
});

test("port publishing rejects an explicit file source before creating an app", async (t) => {
  for (const source of ["local", "workspace"]) {
    const { publish, published, errors } = setup(t);
    await assert.rejects(publish("--source", source), /CLI exit 1/);
    assert.equal(published.length, 0);
    assert.match(errors.join(""), /--source applies only to --file and --dir/);
  }
});
