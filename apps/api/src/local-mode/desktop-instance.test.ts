import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { desktopInstance, desktopInstanceResponse, hasDesktopAccess } from "./desktop-instance.js";

const env = {
  COHUB_DESKTOP_INSTANCE_ID: randomUUID(),
  COHUB_DESKTOP_INSTANCE_SECRET: randomBytes(32).toString("base64url"),
};

test("desktop bootstrap requires the owning client's secret, not a loopback hostname", () => {
  assert.equal(hasDesktopAccess(new Request("http://127.0.0.1/api/local-mode/auth"), env), false);
  assert.equal(hasDesktopAccess(new Request("http://127.0.0.1/api/local-mode/auth", {
    headers: { "x-cohub-desktop-secret": "wrong" },
  }), env), false);
  assert.equal(hasDesktopAccess(new Request("http://127.0.0.1/api/local-mode/auth", {
    headers: { "x-cohub-desktop-secret": env.COHUB_DESKTOP_INSTANCE_SECRET },
  }), env), true);
});

test("instance proof authenticates the process without sending its secret to a listener", async () => {
  const challenge = randomBytes(32).toString("base64url");
  const response = desktopInstanceResponse(new Request(`http://127.0.0.1/instance?challenge=${challenge}`), env);
  const body = await response.json();
  assert.deepEqual(body, {
    schemaVersion: 1,
    instanceId: env.COHUB_DESKTOP_INSTANCE_ID,
    proof: createHmac("sha256", env.COHUB_DESKTOP_INSTANCE_SECRET)
      .update(`cohub-desktop-v1:${env.COHUB_DESKTOP_INSTANCE_ID}:${challenge}`).digest("base64url"),
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(JSON.stringify(body).includes(env.COHUB_DESKTOP_INSTANCE_SECRET), false);
  assert.equal(desktopInstanceResponse(new Request("http://127.0.0.1/instance?challenge=bad"), env).status, 400);
});

test("legacy environments are unchanged and partial desktop identities fail closed", () => {
  assert.equal(desktopInstance({}), null);
  assert.equal(desktopInstanceResponse(new Request("http://127.0.0.1/instance"), {}).status, 404);
  assert.throws(() => desktopInstance({ COHUB_DESKTOP_INSTANCE_ID: env.COHUB_DESKTOP_INSTANCE_ID }), /identity is invalid/);
  assert.throws(() => desktopInstance({ ...env, COHUB_DESKTOP_INSTANCE_ID: "-".repeat(36) }), /identity is invalid/);
});
