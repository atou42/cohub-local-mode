import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

test("Kubernetes is initialized only for cluster operations and shared by concurrent callers", async () => {
  const state = { loads: 0, configs: 0, clients: 0, execs: 0, fail: false };
  Object.assign(globalThis, { __cohubKubernetesTest: state });
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier !== "@kubernetes/client-node") return next(specifier, context);
      state.loads++;
      const source = `
        const state = globalThis.__cohubKubernetesTest;
        export class KubeConfig {
          constructor() { state.configs++; }
          loadFromDefault() { if (state.fail) throw new Error('invalid cluster configuration'); }
          loadFromFile() { this.loadFromDefault(); }
          makeApiClient(Type) { state.clients++; return new Type(); }
        }
        export class CoreV1Api { async readNamespacedPod(input) { return input; } }
        export class CustomObjectsApi {}
        export class Exec { constructor(config) { state.execs++; this.config = config; } }
      `;
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
  });
  try {
    const loaded = await import(`./k8s.ts?lazy=${Date.now()}`);
    const recovery = await import("./lib/sandbox/recovery.js");
    assert.equal(recovery.classifySandboxInfraError("ordinary missing file"), null);
    assert.equal(state.loads, 0, "local API startup must not load the cluster SDK");
    const first = loaded.getKubernetesClients();
    assert.equal(loaded.getKubernetesClients(), first);
    const clients = await first;
    assert.deepEqual(await clients.k8sCoreApi.readNamespacedPod({ name: "test-pod" }), { name: "test-pod" });
    assert.equal(await loaded.getKubernetesClients(), clients);
    assert.deepEqual(state, { loads: 1, configs: 1, clients: 2, execs: 1, fail: false });
    assert.equal(clients.k8sExec.config, clients.kubeConfig);

    state.fail = true;
    const failed = await import(`./k8s.ts?failure=${Date.now()}`);
    await assert.rejects(failed.getKubernetesClients(), /invalid cluster configuration/);
    assert.equal(state.clients, 2, "invalid configuration must not create usable clients");
  } finally {
    hooks.deregister();
    Reflect.deleteProperty(globalThis, "__cohubKubernetesTest");
  }
});
