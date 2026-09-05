import { registerHooks } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

const calls = [];
const warnings = [];
const delays = [];
const authCalls = [];
let now = 0;
let pollIndex = 0;
let meIndex = 0;
const taskId = "cloud-task/id 42";
const input = { userId: "user-test", model: "model-test", content: [{ type: "text", text: "test" }] };

globalThis.cloudGenerationTestAuth = async (options) => {
  authCalls.push(options);
  if (workerData.authError) throw new Error(workerData.authError);
  return "fake-token";
};
const authUrl = `data:text/javascript,${encodeURIComponent("export const resolveAccessToken = globalThis.cloudGenerationTestAuth;")}`;
const configUrl = `data:text/javascript,${encodeURIComponent('export const config = { cloudApiOrigin: "https://cloud.invalid" };')}`;
const productionUrl = new URL("../../src/local-mode/cloud-generation.ts", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@neta-art/cohub-cli/auth") return { url: authUrl, shortCircuit: true };
    if (specifier === "../config.js" && context.parentURL === productionUrl) return { url: configUrl, shortCircuit: true };
    if (specifier === productionUrl) return nextResolve(specifier, context);
    throw new Error(`Unexpected module in isolated cloud generation test: ${specifier}`);
  },
});

Date.now = () => now;
globalThis.setTimeout = (callback, milliseconds) => {
  delays.push(milliseconds);
  now += workerData.clockStep ?? milliseconds;
  queueMicrotask(callback);
  return 0;
};
console.warn = (...args) => warnings.push(args.map(String).join(" "));

function response(step) {
  if (step.networkError) throw new TypeError(step.networkError, { cause: new Error("ECONNRESET") });
  return new Response(step.raw ?? JSON.stringify(step.body), { status: step.status ?? 200 });
}

globalThis.fetch = async (url, init = {}) => {
  const request = { path: new URL(url).pathname, method: init.method ?? "GET", authorization: init.headers?.Authorization };
  calls.push(request);
  if (request.path === "/api/me") {
    return response(workerData.me?.[meIndex++] ?? { body: { uuid: input.userId } });
  }
  if (request.path === "/api/spaces/default") return response({ body: { space: { id: "space-test" } } });
  if (request.path === "/api/generations" && request.method === "POST") {
    return response(workerData.post ?? { body: { taskRunId: taskId } });
  }
  if (request.path === `/api/tasks/${encodeURIComponent(taskId)}` && request.method === "GET") {
    const step = workerData.polls[pollIndex++] ?? workerData.repeatPoll;
    if (!step) throw new Error("Unexpected extra cloud task poll");
    return response(step);
  }
  throw new Error(`Unexpected request in isolated cloud generation test: ${request.method} ${request.path}`);
};

const serializeError = (error) => ({
  name: error.name,
  message: error.message,
  ...(error.cause ? { cause: serializeError(error.cause) } : {}),
});

const { runCloudGeneration } = await import(productionUrl);
try {
  const result = await runCloudGeneration(input);
  parentPort.postMessage({ result, calls, warnings, delays, authCalls });
} catch (error) {
  parentPort.postMessage({ error: serializeError(error), calls, warnings, delays, authCalls });
}
