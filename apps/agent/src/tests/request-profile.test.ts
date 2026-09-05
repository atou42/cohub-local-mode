import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelsConfig } from "@cohub/infra/config-runtime/models";
import { CohubModelRegistry } from "../runtime/model-registry.js";
import { applyRequestProfile, type ProfiledModel } from "../runtime/request-profile.js";

const config: ModelsConfig = {
  providers: {
    test: {
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      headers: { Originator: "provider", "User-Agent": "provider-agent", "X-Shared": "provider" },
      models: [
        {
          id: "gpt-test",
          requestProfile: "codex",
          compat: { sessionAffinityFormat: "openai-nosession" },
          headers: { originator: "codex_cli_rs", "user-agent": "codex_cli_rs/test", "x-shared": "model" },
        },
      ],
    },
  },
};

const registry = new CohubModelRegistry({ configs: [config] });
const model = registry.find("test", "gpt-test");
assert.ok(model);
assert.equal(model.requestProfile, "codex");
assert.equal(registry.getHeaders("test", "gpt-test"), model.headers);
assert.deepEqual(model.headers, {
  originator: "codex_cli_rs",
  "user-agent": "codex_cli_rs/test",
  "x-shared": "model",
});

const sessionId = "x".repeat(67);
const options = applyRequestProfile(model, {
  sessionId,
  threadId: "thread-branch",
  headers: { "Session-Id": "override", "X-Request": "request" },
});
assert.deepEqual(options.headers, {
  "thread-id": "thread-branch",
  "Session-Id": "override",
  "X-Request": "request",
});

const alternateCompatModel = {
  ...model,
  compat: { sessionAffinityFormat: "openai" },
} as ProfiledModel;
assert.deepEqual(applyRequestProfile(alternateCompatModel, { sessionId: "session" }).headers, {
  "session-id": "session",
  "thread-id": "session",
});

const alternateApiModel = {
  ...model,
  api: "anthropic-messages",
} as Model<"anthropic-messages"> & { requestProfile: "codex" };
assert.deepEqual(applyRequestProfile(alternateApiModel, { sessionId: "session" }).headers, {
  "session-id": "session",
  "thread-id": "session",
});

const missingEnvName = "COHUB_TEST_MISSING_PROVIDER_KEY";
delete process.env[missingEnvName];
const missingEnvRegistry = new CohubModelRegistry({
  configs: [{
    providers: {
      test: {
        api: "openai-responses",
        baseUrl: "https://example.test/v1",
        apiKey: missingEnvName,
        models: [{ id: "missing-key" }],
      },
    },
  }],
});
assert.equal(missingEnvRegistry.getApiKey("test"), undefined);

const literalKeyRegistry = new CohubModelRegistry({
  configs: [{
    providers: {
      test: {
        api: "openai-responses",
        baseUrl: "https://example.test/v1",
        apiKey: "sk-test-literal",
        models: [{ id: "literal-key" }],
      },
    },
  }],
});
assert.equal(literalKeyRegistry.getApiKey("test"), "sk-test-literal");
