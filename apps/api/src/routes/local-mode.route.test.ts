import assert from "node:assert/strict";
import test from "node:test";
import { hasTrustedLocalModeEntry } from "./local-mode.route.js";

test("production Local Mode auth accepts loopback and Cloudflare Access only", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.equal(
      hasTrustedLocalModeEntry(
        new Request("http://127.0.0.1:8787/api/local-mode/auth"),
      ),
      true,
    );
    assert.equal(
      hasTrustedLocalModeEntry(
        new Request("http://localhost:8787/api/local-mode/auth"),
      ),
      true,
    );
    assert.equal(
      hasTrustedLocalModeEntry(
        new Request("https://cohub.example.com/api/local-mode/auth"),
      ),
      false,
    );
    assert.equal(
      hasTrustedLocalModeEntry(
        new Request("https://cohub.example.com/api/local-mode/auth", {
          headers: { "cf-access-jwt-assertion": "verified-at-the-edge" },
        }),
      ),
      true,
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
