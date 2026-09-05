import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const toolsUrl = new URL("../../sandbox/tools.ts", import.meta.url).href;
const scenario = process.argv[2];
const command = "cat <<'EOF'\ninput with $variables and 'quotes'\nEOF";
const failure = new Error("fake RPC transport failed");
const requests = [];
const chunks = [];
const context = { spaceId: "isolated-space", sessionId: "isolated-session" };
const connection = {
  sandboxId: "isolated-sandbox",
  async request(method, params, options) {
    requests.push({ method, params });
    assert.equal(method, "process.start");
    assert.equal(params.closeStdin, true);
    assert.equal(params.command, command);
    assert.equal(params.cwd, "/workspace");
    assert.equal(params.timeoutSecs, 7);
    assert.equal(params.env.TEST_INPUT, "preserved");
    if (scenario === "rpc-failure") throw failure;
    options.onEvent({ type: "started", processId: "process-test" });
    options.onEvent({ type: "stdout", chunk: "EOF reached\n" });
    options.onEvent({ type: "exit", exitCode: 0, termination: { reason: "exited", exitCode: 0 } });
    return { processId: "process-test", exitCode: 0 };
  },
};
globalThis.__piStdinTest = { context, connection, chunks };

// Load the real sandbox tools module, but none of its DB, queue, or service
// imports. Unused operations throw so an unexpected path cannot pass silently.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === toolsUrl && !specifier.startsWith("node:")) {
      return { url: "pi-stdin:dependencies", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url !== "pi-stdin:dependencies") return nextLoad(url, context);
    return {
      format: "module", shortCircuit: true,
      source: `
        const state = globalThis.__piStdinTest;
        const unused = () => { throw new Error("Unexpected service or unused tool access"); };
        const tool = () => ({ name: "unused", execute: unused });
        export const createBashTool = (cwd, { operations }) => ({ name: "bash", execute: () => operations.exec({
          command: ${JSON.stringify(command)}, cwd, timeout: 7, env: { TEST_INPUT: "preserved" },
          onData: (data) => state.chunks.push(data.toString())
        }) });
        export const createReadTool = tool, createWriteTool = tool, createEditTool = tool,
          createFindTool = tool, createLsTool = tool, createGrepToolDefinition = tool,
          createLocalCrossSpaceFindTool = tool, createLocalCrossSpaceGrepTool = tool,
          createLocalCrossSpaceLsTool = tool, createLocalCrossSpaceReadTool = tool,
          createCloudCrossSpaceFindTool = tool, createCloudCrossSpaceGrepTool = tool,
          createCloudCrossSpaceLsTool = tool, createCloudCrossSpaceReadTool = tool,
          createSpaceAwareFindTool = tool, createSpaceAwareGrepTool = tool,
          createSpaceAwareLsTool = tool, createSpaceAwareReadTool = tool;
        export const createToolFailure = unused, createThrottledTextToolUpdate = unused,
          applyEditsToContent = unused, detectUnsupportedReadImageMimeType = unused,
          isSupportedReadImageMimeType = unused, unsupportedReadImageMimeTypeMessage = unused,
          formatRgJsonGrepResult = unused, encodeGenerationPolicy = unused,
          enqueueTaskRun = unused, resolveSpaceFileVisibility = unused,
          createWorkspaceVisibilityFilter = unused, disconnectSandboxWsClient = unused,
          getSandboxRpcFailurePresentation = unused, getSpaceSandbox = unused,
          recoverSpaceSandbox = unused, dispatchTaskCreated = unused, eq = unused;
        export const DEFAULT_MAX_BYTES = 1024, GENERATION_POLICY_ENV_KEY = "TEST_POLICY",
          RUN_COMMAND_TASK_TYPE = "unused", COHUB_TASKS_QUEUE = "unused", spaces = {};
        export const createBullmqQueue = () => new Proxy({}, { get: unused });
        export const db = new Proxy({}, { get: unused });
        export const env = { COHUB_NODE_ORIGIN: "cloud" };
        export const logger = { debug() {}, info() {}, warn() {}, error() {} };
        export const wrapToolCall = (_tracer, _context, run) => run();
        export const wrapSandboxRpc = wrapToolCall;
        export const getAgentTracer = () => ({});
        export const createSandboxLifecycleController = () => ({ recordActivity: async () => {} });
        export const getAgentPlatformAgentsPath = () => "/platform/agents";
        export const getAgentPlatformConfigPath = () => "/platform";
        export const getAgentWorkspacePath = () => "/workspace";
        export const SANDBOX_PLATFORM_AGENTS_PATH = "/platform/agents", SANDBOX_WORKSPACE_PATH = "/workspace";
        export const getCurrentSessionExecutionAuth = unused;
        export const getCurrentToolExecutionContext = () => state.context;
        export const runWithToolExecutionContext = async (context, run) => {
          const previous = state.context;
          state.context = { ...previous, ...context };
          try { return await run(); } finally { state.context = previous; }
        };
        export const ensureSandboxConnection = async () => state.connection;
        export const pruneSandboxConnections = () => {};
        export const isSandboxRpcError = () => false;
        export const classifySandboxInfrastructureError = () => null;
        export class SandboxRpcError extends Error {}
        export const SANDBOX_NOT_READY_MESSAGE = "Not ready";
        export const registerActiveAbortHandle = unused;
      `,
    };
  },
});

try {
  const { createSandboxCodingTools } = await import(toolsUrl);
  const bash = createSandboxCodingTools().find((tool) => tool.name === "bash");
  assert.ok(bash);
  if (scenario === "rpc-failure") {
    await assert.rejects(bash.execute("test-call", {}), (error) => error === failure);
    assert.deepEqual(chunks, []);
  } else {
    const result = await bash.execute("test-call", {});
    assert.deepEqual(result, { exitCode: 0, termination: { reason: "exited", exitCode: 0 } });
    assert.deepEqual(chunks, ["EOF reached\n"]);
  }
  assert.equal(requests.length, 1);
  console.log(JSON.stringify({ scenario, requests: requests.length }));
} finally {
  hooks.deregister();
  delete globalThis.__piStdinTest;
}
