import assert from "node:assert/strict";
import test from "node:test";
import { hasTrustedLocalModeEntry } from "./local-mode.route.js";

test("production Local Mode auth accepts loopback, owner Tailscale, and Cloudflare Access only", () => {
  const previous = process.env.NODE_ENV;
  const previousHost = process.env.COHUB_LOCAL_TAILSCALE_HOST;
  const previousOwner = process.env.COHUB_LOCAL_OWNER_EMAIL;
  process.env.NODE_ENV = "production";
  process.env.COHUB_LOCAL_TAILSCALE_HOST = "macmini.example.ts.net";
  process.env.COHUB_LOCAL_OWNER_EMAIL = "owner@example.com";
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
    assert.equal(
      hasTrustedLocalModeEntry(
        new Request("https://macmini.example.ts.net/api/local-mode/auth", {
          headers: { "tailscale-user-login": "owner@example.com" },
        }),
      ),
      true,
    );
    assert.equal(
      hasTrustedLocalModeEntry(
        new Request("https://other.example.ts.net/api/local-mode/auth", {
          headers: { "tailscale-user-login": "owner@example.com" },
        }),
      ),
      false,
    );
    assert.equal(
      hasTrustedLocalModeEntry(
        new Request("https://macmini.example.ts.net/api/local-mode/auth", {
          headers: { "tailscale-user-login": "attacker@example.com" },
        }),
      ),
      false,
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
    if (previousHost === undefined) delete process.env.COHUB_LOCAL_TAILSCALE_HOST;
    else process.env.COHUB_LOCAL_TAILSCALE_HOST = previousHost;
    if (previousOwner === undefined) delete process.env.COHUB_LOCAL_OWNER_EMAIL;
    else process.env.COHUB_LOCAL_OWNER_EMAIL = previousOwner;
  }
});
