import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAppRuntimeConfigureRequest,
  buildAppRuntimePointer,
  parseAppRuntimeConfigureRequest,
  parseAppRuntimePointer,
} from "./src/app-runtime.js";

test("configure.request round-trips geometry and input region", () => {
  const message = parseAppRuntimeConfigureRequest(
    buildAppRuntimeConfigureRequest({
      geometry: { anchor: "bottom-right", x: 12, y: 12, width: 260, height: 220 },
      inputRegion: [{ x: 0, y: 0, width: 260, height: 220 }],
    }),
  );
  assert.deepEqual(message?.geometry, { anchor: "bottom-right", x: 12, y: 12, width: 260, height: 220 });
  assert.deepEqual(message?.inputRegion, [{ x: 0, y: 0, width: 260, height: 220 }]);
});

test("configure.request rejects a geometry with any invalid field, keeping the rest", () => {
  const message = parseAppRuntimeConfigureRequest({
    protocol: "cohub.app.runtime",
    version: 1,
    type: "configure.request",
    geometry: { anchor: "middle", x: "10", y: Number.NaN, width: -1, height: 40 },
    inputRegion: [{ x: 0, y: 0, width: 0, height: 10 }, { x: 1, y: 2, width: 3, height: 4 }, "junk"],
  });
  // Dropping only the bad axes would leave `{}` — a fill — and could grow a
  // fixed panel to the whole layer, so the whole shape is ignored.
  assert.equal(message?.geometry, undefined);
  assert.deepEqual(message?.inputRegion, [{ x: 1, y: 2, width: 3, height: 4 }]);
});

test("configure.request accepts the keyword input regions and rejects other envelopes", () => {
  assert.equal(parseAppRuntimeConfigureRequest(buildAppRuntimeConfigureRequest({ inputRegion: "all" }))?.inputRegion, "all");
  assert.equal(parseAppRuntimeConfigureRequest(buildAppRuntimeConfigureRequest({ inputRegion: "none" }))?.inputRegion, "none");
  assert.equal(parseAppRuntimeConfigureRequest({ protocol: "cohub.app.runtime", version: 1, type: "ready" }), null);
  assert.equal(parseAppRuntimeConfigureRequest(null), null);
});

test("configure.request distinguishes an explicit fill from rejected sizes", () => {
  assert.deepEqual(parseAppRuntimeConfigureRequest(buildAppRuntimeConfigureRequest({ geometry: {} }))?.geometry, {});
  assert.equal(parseAppRuntimeConfigureRequest({ protocol: "cohub.app.runtime", version: 1, type: "configure.request" })?.geometry, undefined);
  assert.equal(parseAppRuntimeConfigureRequest(buildAppRuntimeConfigureRequest({ geometry: { width: 0 } }))?.geometry, undefined);
  assert.equal(parseAppRuntimeConfigureRequest(buildAppRuntimeConfigureRequest({ geometry: { height: Number.NaN } }))?.geometry, undefined);
});

test("pointer round-trips and coerces the button flag", () => {
  assert.deepEqual(parseAppRuntimePointer(buildAppRuntimePointer({ x: 12, y: 34, down: true })), {
    protocol: "cohub.app.runtime",
    version: 1,
    type: "pointer",
    x: 12,
    y: 34,
    down: true,
  });
  assert.equal(parseAppRuntimePointer(buildAppRuntimePointer({ x: 0, y: 0, down: false }))?.down, false);
  assert.equal(
    parseAppRuntimePointer({ protocol: "cohub.app.runtime", version: 1, type: "pointer", x: 1, y: 2 }).down,
    false,
  );
});

test("pointer rejects non-finite coordinates and other envelopes", () => {
  assert.equal(
    parseAppRuntimePointer({ protocol: "cohub.app.runtime", version: 1, type: "pointer", x: Number.NaN, y: 2, down: false }),
    null,
  );
  assert.equal(
    parseAppRuntimePointer({ protocol: "cohub.app.runtime", version: 1, type: "pointer", x: "1", y: 2, down: false }),
    null,
  );
  assert.equal(parseAppRuntimePointer(buildAppRuntimeConfigureRequest({ inputRegion: "all" })), null);
  assert.equal(parseAppRuntimePointer(null), null);
});
