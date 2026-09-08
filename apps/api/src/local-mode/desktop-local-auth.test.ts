import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { createDesktopLocalAccessToken, verifyDesktopLocalAccessToken } from "./desktop-local-auth.js";
import type { LocalDesktopIdentity } from "./personal-node-cloud-auth.js";

const issuer = "https://auth.example/oidc";
const account = (subject = "user-a"): LocalDesktopIdentity => ({
  issuer, subject, accountId: createHash("sha256").update(`${issuer}\0${subject}`).digest("hex"),
  deviceId: "e91fab11-b18b-46ee-8338-913fbcd1b140", userUuid: "7c3b9d14-b3db-4dd9-a146-559ebfc1e14e", clientId: "desktop-app",
});
const env = { COHUB_NODE_ORIGIN: "local", COHUB_DESKTOP_INSTANCE_ID: randomUUID(), COHUB_DESKTOP_INSTANCE_SECRET: randomBytes(32).toString("base64url") };
const request = () => new Request("http://127.0.0.1:8787/api/local-mode/auth?desktop=1", { headers: { "x-cohub-desktop-secret": env.COHUB_DESKTOP_INSTANCE_SECRET } });
const deps = { env, now: Date.parse("2026-09-06T00:00:00Z"), readIdentity: async () => account() };

test("local desktop authorization does not require a cloud access token or a refresh", async () => {
  const token = await createDesktopLocalAccessToken(request(), issuer, deps);
  assert.ok(token);
  assert.deepEqual(await verifyDesktopLocalAccessToken(token, request(), issuer, deps), { uuid: account().userUuid, sub: "user-a", clientId: "desktop-app" });
  await assert.rejects(verifyDesktopLocalAccessToken(token, request(), issuer, { ...deps, now: deps.now + 3_600_000 }), /expired/);
});

test("local grants preserve compact user identifiers from verified production claims", async () => {
  const current = { ...account(), userUuid: "7c3b9d14b3db4dd9a146559ebfc1e14e" };
  const compact = { ...deps, readIdentity: async () => current };
  const token = await createDesktopLocalAccessToken(request(), issuer, compact);
  assert.ok(token);
  assert.equal((await verifyDesktopLocalAccessToken(token, request(), issuer, compact))?.uuid, current.userUuid);
});

test("account, device, issuer, signature and instance changes invalidate the grant", async () => {
  const token = (await createDesktopLocalAccessToken(request(), issuer, deps))!;
  for (const current of [null, account("user-b"), { ...account(), deviceId: randomUUID() }, { ...account(), userUuid: randomUUID() }]) {
    await assert.rejects(verifyDesktopLocalAccessToken(token, request(), issuer, { ...deps, readIdentity: async () => current }), /changed|disconnected/);
  }
  await assert.rejects(verifyDesktopLocalAccessToken(token, request(), "https://other.example/oidc", deps), /changed/);
  await assert.rejects(verifyDesktopLocalAccessToken(`${token.slice(0, -2)}aa`, request(), issuer, deps), /signature/);
  await assert.rejects(verifyDesktopLocalAccessToken(token, request(), issuer, { ...deps, env: { ...env, COHUB_DESKTOP_INSTANCE_ID: randomUUID() } }), /instance/);
});

test("untrusted hosts and a missing desktop secret cannot mint or use local grants", async () => {
  const token = (await createDesktopLocalAccessToken(request(), issuer, deps))!;
  for (const untrusted of [new Request("http://127.0.0.1/api/local-mode/auth"), new Request("https://remote.example/api/local-mode/auth", { headers: request().headers })]) {
    await assert.rejects(createDesktopLocalAccessToken(untrusted, issuer, deps), /owning instance/);
    await assert.rejects(verifyDesktopLocalAccessToken(token, untrusted, issuer, deps), /owning instance/);
  }
  assert.equal(await verifyDesktopLocalAccessToken("ordinary-cloud-token", request(), issuer, deps), undefined);
  assert.equal(await createDesktopLocalAccessToken(request(), issuer, { ...deps, readIdentity: async () => undefined }), undefined);
  await assert.rejects(createDesktopLocalAccessToken(request(), issuer, { ...deps, readIdentity: async () => { throw new Error("locked Keychain"); } }), /locked/);
});

test("a real HTTP session retains local access offline and rejects the former account after switching", async (t) => {
  let current: LocalDesktopIdentity | null = account();
  const server = createServer(async (req, res) => {
    const incoming = new Request(`http://127.0.0.1${req.url}`, { headers: req.headers as Record<string, string> });
    try {
      const options = { ...deps, readIdentity: async () => current };
      const body = req.url === "/auth" ? { token: await createDesktopLocalAccessToken(incoming, issuer, options) } : await verifyDesktopLocalAccessToken(req.headers.authorization!.slice(7), incoming, issuer, options);
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body));
    } catch { res.writeHead(401); res.end("unauthorized"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const signedIn = await fetch(`${origin}/auth`, { headers: request().headers });
  const { token } = await signedIn.json();
  const headers = { ...Object.fromEntries(request().headers), authorization: `Bearer ${token}` };
  assert.equal((await (await fetch(`${origin}/me`, { headers })).json()).uuid, account().userUuid);
  current = account("user-b");
  assert.equal((await fetch(`${origin}/me`, { headers })).status, 401);
});
