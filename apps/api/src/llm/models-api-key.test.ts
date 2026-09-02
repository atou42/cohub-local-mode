import assert from "node:assert/strict";
import { CompletionModelRegistry } from "./models.js";

const missingEnvName = "COHUB_TEST_MISSING_COMPLETION_KEY";
delete process.env[missingEnvName];

const missingEnvRegistry = new CompletionModelRegistry([{
  providers: {
    test: {
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      apiKey: missingEnvName,
      models: [{ id: "missing-key" }],
    },
  },
}]);
assert.equal(missingEnvRegistry.getApiKey("test"), undefined);

const literalKeyRegistry = new CompletionModelRegistry([{
  providers: {
    test: {
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test-literal",
      models: [{ id: "literal-key" }],
    },
  },
}]);
assert.equal(literalKeyRegistry.getApiKey("test"), "sk-test-literal");
