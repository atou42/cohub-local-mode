import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Every internal path the Gateway calls must exist on the API's internal Gateway router.
// A one-sided rename once left App room joins failing with 404.
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const called = new Set(
  [...read("../../../../gateway/src/api-client.ts").matchAll(/\/internal\/gateway\/([a-z0-9/-]+)/g)].map((match) => match[1]),
);
const served = new Set(
  [...read("./gateway.route.ts").matchAll(/router\.(?:get|post|put|delete)\("\/([a-z0-9/-]+)"/g)].map((match) => match[1]),
);

assert.ok(called.size > 0, "no Gateway calls found");
for (const path of called) {
  assert.ok(served.has(path), `Gateway calls /internal/gateway/${path}, which the API does not serve`);
}
