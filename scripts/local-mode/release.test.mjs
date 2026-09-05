import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { releaseLocalMode } from "./release.mjs";
import { buildWebDeploymentMessage } from "./web-deployment.mjs";
import {
  RELAY_BROWSER_PROTOCOL_VERSION,
  RELAY_EVENT_SCHEMA_VERSION,
  RELAY_PROTOCOL_VERSION,
} from "../../apps/local-relay/node/protocol-compat.mjs";

const compatibility = {
  nodeProtocolVersion: RELAY_PROTOCOL_VERSION,
  browserProtocolVersion: RELAY_BROWSER_PROTOCOL_VERSION,
  eventSchemaVersion: RELAY_EVENT_SCHEMA_VERSION,
};
const ids = {
  relay: { old: "11111111-1111-4111-8111-111111111111", next: "22222222-2222-4222-8222-222222222222" },
  web: { old: "33333333-3333-4333-8333-333333333333", next: "44444444-4444-4444-8444-444444444444" },
  other: "55555555-5555-4555-8555-555555555555",
};
const oldMessages = {
  relay: "cohub-local-relay source old-relay",
  web: buildWebDeploymentMessage("old-web", compatibility),
};

function fixture(options = {}) {
  const events = [];
  let clock = 0;
  const deployment = (versionId, message) => ({
    created_on: new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString(),
    annotations: { "workers/message": message },
    versions: [{ version_id: versionId, percentage: 100 }],
  });
  const state = Object.fromEntries(["relay", "web"].map((target) => [target, [deployment(ids[target].old, oldMessages[target])]]));
  options.mutate?.(state);
  const calls = { relay: 0, web: 0 };
  let webReads = 0;
  const failure = new Error(options.fail ?? "injected failure");
  const dependencies = {
    readWebVersion: async () => {
      events.push("read-web");
      webReads += 1;
      if (options.fail === "read-web" && webReads === 2) throw failure;
      return webReads === 1 ? "old-web" : "new-web";
    },
    readRelayVersion: async () => "new-relay",
    retentionReady: async () => { events.push("retention-ready"); },
    readRetainedVersions: async () => [],
    relayUrl: options.relayUrl ?? "wss://relay.example.test/connect",
    health: async ({ url, expected }) => {
      events.push("health");
      assert.equal(url, "https://relay.example.test/healthz");
      assert.equal(expected.protocolVersion, RELAY_PROTOCOL_VERSION);
      if (options.fail === "health") throw failure;
    },
    log: (text) => events.push(`log:${text}`),
    run: async (program, args, commandOptions = {}) => {
      if (args.includes("wrangler")) {
        const target = commandOptions.cwd?.endsWith("apps/local-relay") ? "relay" : "web";
        if (args.includes("secret")) {
          events.push("secrets");
          return { stdout: JSON.stringify(["NODE_TOKEN", "OWNER_EMAIL", "OWNER_USER_ID", "POLICY_AUD", "TEAM_DOMAIN"].map((name) => ({ name }))) };
        }
        if (args.includes("deployments")) {
          events.push(`list:${target}`);
          calls[target] += 1;
          if (options.fail === `verify:${target}` && state[target][0].versions[0].version_id === ids[target].next && !options.verifyFailed) {
            options.verifyFailed = true;
            throw failure;
          }
          if (options.fail === "concurrent" && target === "web" && state.web[0].versions[0].version_id === ids.web.next) {
            state.web.unshift(deployment(ids.other, "third party"));
            throw failure;
          }
          if (options.fail === "recovery-query" && target === "relay" && calls.relay >= 2) throw failure;
          if (options.fail === "recovery-data" && target === "relay" && calls.relay >= 2) {
            return { stdout: JSON.stringify([{ ...state.relay[0], created_on: "bad" }]) };
          }
          if (options.fail === "invalid-verify:web" && target === "web" && state.web[0].versions[0].version_id === ids.web.next && !options.verifyFailed) {
            options.verifyFailed = true;
            const invalid = structuredClone(state.web);
            invalid[0].versions[0].percentage = 99;
            return { stdout: JSON.stringify(invalid) };
          }
          return { stdout: JSON.stringify(state[target]) };
        }
        if (args.includes("deploy") && !args.includes("versions")) {
          events.push(`deploy:${target}`);
          const message = args[args.indexOf("--message") + 1];
          if (options.fail === `deploy:${target}`) throw failure;
          state[target].unshift(deployment(ids[target].next, message));
          if (options.fail === `applied:${target}` || (["recovery-query", "recovery-data"].includes(options.fail) && target === "relay")) throw failure;
          return { stdout: "" };
        }
        if (args.includes("versions") && args.includes("deploy")) {
          events.push(`rollback:${target}`);
          assert.equal(args[args.indexOf("deploy") + 1], `${ids[target].old}@100`);
          assert.equal(args[args.indexOf("--message") + 1], oldMessages[target]);
          assert.equal(commandOptions.capture, true);
          assert.equal(args.includes("rollback"), false);
          assert.equal(args.includes("--yes"), false);
          assert.equal(args.some((arg) => arg.includes("force")), false);
          if (options.rollbackFail === target) {
            const error = new Error(`rollback rejected ${target}`);
            error.stdout = "Deploying 1 version(s)";
            error.stderr = "API error 10220: secrets changed; refusing restoration";
            throw error;
          }
          if (options.rollbackNoop !== target) state[target].unshift(deployment(ids[target].old, oldMessages[target]));
          return options.rollbackNoop === target
            ? { stdout: "Aborting deployment: secrets changed", stderr: "Restoration was not applied" }
            : { stdout: "" };
        }
        assert.fail(`Unexpected command: ${program} ${args.join(" ")}`);
      }
      if (args.includes("restart")) {
        events.push("restart");
        if (options.fail === "restart") throw failure;
      } else {
        events.push(`check:${args.join(" ")}`);
        if (options.fail === "build") throw failure;
      }
      return { stdout: "" };
    },
  };
  return { dependencies, events, state, failure };
}

function effects(f) {
  return f.events.filter((event) => /^(deploy:|rollback:|restart$)/.test(event));
}

test("import does not load an environment file or start any process", async (t) => {
  let envLoads = 0;
  let spawns = 0;
  t.mock.method(process, "loadEnvFile", () => { envLoads += 1; throw new Error("unexpected env load"); });
  t.mock.method(childProcess, "spawn", () => { spawns += 1; throw new Error("unexpected process spawn"); });
  syncBuiltinESMExports();
  try {
    const module = await import("./release.mjs?import-safety");
    assert.equal(typeof module.releaseLocalMode, "function");
    assert.equal(envLoads, 0);
    assert.equal(spawns, 0);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

for (const [fail, expected] of [
  ["deploy:web", ["deploy:relay", "deploy:web", "rollback:relay"]],
  ["verify:web", ["deploy:relay", "deploy:web", "rollback:web", "rollback:relay"]],
  ["verify:relay", ["deploy:relay", "rollback:relay"]],
  ["applied:relay", ["deploy:relay", "rollback:relay"]],
  ["applied:web", ["deploy:relay", "deploy:web", "rollback:web", "rollback:relay"]],
  ["health", ["deploy:relay", "rollback:relay"]],
  ["deploy:relay", ["deploy:relay"]],
]) {
  test(`${fail} preserves the failure and restores attempted deployments in reverse order`, async () => {
    const f = fixture({ fail });
    await assert.rejects(releaseLocalMode(f.dependencies), (error) => {
      assert.equal(error.cause, f.failure);
      assert.match(error.message, new RegExp(fail));
      return true;
    });
    assert.deepEqual(effects(f), expected);
    for (const target of ["relay", "web"]) {
      assert.equal(f.state[target][0].versions[0].version_id, ids[target].old);
      assert.equal(f.state[target][0].versions[0].percentage, 100);
      assert.equal(f.state[target][0].annotations["workers/message"], oldMessages[target]);
    }
  });
}

test("success completes preflight before deploy and restarts once without rollback", async () => {
  const f = fixture();
  await releaseLocalMode(f.dependencies);
  assert.deepEqual(effects(f), ["deploy:relay", "deploy:web", "restart"]);
  const firstDeploy = f.events.indexOf("deploy:relay");
  assert.ok(f.events.lastIndexOf("read-web") < firstDeploy);
  assert.ok(f.events.indexOf("secrets") < firstDeploy);
  assert.ok(f.events.findIndex((e) => e.includes("@cohub/protocol build")) < firstDeploy);
  assert.ok(f.events.findIndex((e) => e.includes("--filter web test")) < firstDeploy);
  assert.equal(f.events.filter((e) => e === "list:relay").length, 2);
  assert.equal(f.events.filter((e) => e === "list:web").length, 3);
  assert.ok(f.events.indexOf("health") < f.events.indexOf("deploy:web"));
  assert.match(f.events.at(-1), /release is ready with web build new-web and Relay new-relay/);
});

for (const fail of ["build", "read-web"]) {
  test(`${fail} fails before any deployment`, async () => {
    const f = fixture({ fail });
    await assert.rejects(releaseLocalMode(f.dependencies), f.failure);
    assert.deepEqual(effects(f), []);
  });
}

test("invalid Relay URL fails before either deployment", async () => {
  const f = fixture({ relayUrl: "https://relay.example.test" });
  await assert.rejects(releaseLocalMode(f.dependencies), /must use WebSocket/);
  assert.deepEqual(effects(f), []);
});

for (const [name, mutate] of [
  ["singleton bad time", (s) => { s.relay[0].created_on = "bad"; }],
  ["historical bad time", (s) => { s.relay.push({ ...s.relay[0], created_on: "bad" }); }],
  ["impossible calendar date", (s) => { s.relay[0].created_on = "2026-02-30T00:00:00Z"; }],
  ["ambiguous latest time", (s) => { s.relay.push(structuredClone(s.relay[0])); }],
  ["bad version ID", (s) => { s.web[0].versions[0].version_id = "not-a-uuid"; }],
  ["historical bad version ID", (s) => { s.relay.push({ ...structuredClone(s.relay[0]), created_on: "2025-01-01T00:00:00Z", versions: [{ version_id: "bad", percentage: 100 }] }); }],
  ["historical bad percentage", (s) => { s.relay.push({ ...structuredClone(s.relay[0]), created_on: "2025-01-01T00:00:00Z", versions: [{ version_id: ids.other, percentage: -1 }] }); }],
  ["missing message", (s) => { delete s.relay[0].annotations; }],
  ["string percentage", (s) => { s.relay[0].versions[0].percentage = "100"; }],
  ["split deployment", (s) => { s.relay[0].versions = [{ version_id: ids.relay.old, percentage: 50 }, { version_id: ids.other, percentage: 50 }]; }],
]) {
  test(`bad snapshot (${name}) performs zero deployments`, async () => {
    const f = fixture({ mutate });
    await assert.rejects(releaseLocalMode(f.dependencies));
    assert.deepEqual(effects(f), []);
  });
}

test("rollback rejection exposes original error and both target outcomes without restart", async () => {
  const f = fixture({ fail: "verify:web", rollbackFail: "web" });
  await assert.rejects(releaseLocalMode(f.dependencies), (error) => {
    assert.equal(error.cause, f.failure);
    assert.match(error.message, /verify:web/);
    assert.match(error.message, /rollback rejected web/);
    assert.match(error.message, /API error 10220: secrets changed; refusing restoration/);
    assert.match(error.message, /Deploying 1 version\(s\)/);
    assert.ok(error.message.includes(ids.web.old));
    assert.ok(error.message.includes(ids.relay.old));
    return true;
  });
  assert.deepEqual(effects(f), ["deploy:relay", "deploy:web", "rollback:web", "rollback:relay"]);
  assert.equal(f.state.web[0].versions[0].version_id, ids.web.next);
  assert.equal(f.state.relay[0].versions[0].version_id, ids.relay.old);
});

test("a zero exit code after refusing a secret change cannot claim restoration", async () => {
  const f = fixture({ fail: "health", rollbackNoop: "relay" });
  await assert.rejects(releaseLocalMode(f.dependencies), (error) => {
    assert.match(error.message, /not restored/);
    assert.match(error.message, /Aborting deployment: secrets changed/);
    assert.match(error.message, /Restoration was not applied/);
    return true;
  });
  assert.deepEqual(effects(f), ["deploy:relay", "rollback:relay"]);
  assert.equal(f.state.relay[0].versions[0].version_id, ids.relay.next);
});

test("restoration API rejection never retries with force or the rollback subcommand", async () => {
  const f = fixture({ fail: "health", rollbackFail: "relay" });
  await assert.rejects(releaseLocalMode(f.dependencies), (error) => {
    assert.equal(error.cause, f.failure);
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[1].stderr, "API error 10220: secrets changed; refusing restoration");
    return true;
  });
  assert.deepEqual(effects(f), ["deploy:relay", "rollback:relay"]);
  assert.equal(f.state.relay[0].versions[0].version_id, ids.relay.next);
});

test("third-party current version is not overwritten and the other target is restored", async () => {
  const f = fixture({ fail: "concurrent" });
  await assert.rejects(releaseLocalMode(f.dependencies), /concurrent|third.party/);
  assert.deepEqual(effects(f), ["deploy:relay", "deploy:web", "rollback:relay"]);
  assert.equal(f.state.web[0].versions[0].version_id, ids.other);
  assert.equal(f.state.relay[0].versions[0].version_id, ids.relay.old);
});

test("recovery query failure never guesses a rollback target", async () => {
  const f = fixture({ fail: "recovery-query" });
  await assert.rejects(releaseLocalMode(f.dependencies), /recovery-query/);
  assert.deepEqual(effects(f), ["deploy:relay"]);
  assert.equal(f.state.relay[0].versions[0].version_id, ids.relay.next);
});

test("malformed recovery data never triggers a rollback", async () => {
  const f = fixture({ fail: "recovery-data" });
  await assert.rejects(releaseLocalMode(f.dependencies), (error) => {
    assert.equal(error.cause, f.failure);
    assert.match(error.message, /not restored at inspect.*invalid deployment created_on/);
    return true;
  });
  assert.deepEqual(effects(f), ["deploy:relay"]);
  assert.equal(f.state.relay[0].versions[0].version_id, ids.relay.next);
});

test("invalid deployment response fails the real validation gate and restores both targets", async () => {
  const f = fixture({ fail: "invalid-verify:web" });
  await assert.rejects(releaseLocalMode(f.dependencies), /web verify.*percentages do not total 100/);
  assert.deepEqual(effects(f), ["deploy:relay", "deploy:web", "rollback:web", "rollback:relay"]);
  assert.equal(f.state.web[0].versions[0].version_id, ids.web.old);
  assert.equal(f.state.relay[0].versions[0].version_id, ids.relay.old);
});

test("restart failure does not roll back remote deployments", async () => {
  const f = fixture({ fail: "restart" });
  await assert.rejects(releaseLocalMode(f.dependencies), /restart.*remote deployments.*not rolled back/i);
  assert.deepEqual(effects(f), ["deploy:relay", "deploy:web", "restart"]);
  assert.equal(f.state.web[0].versions[0].version_id, ids.web.next);
  assert.equal(f.state.relay[0].versions[0].version_id, ids.relay.next);
});
