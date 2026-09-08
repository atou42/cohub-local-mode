import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

test("installed local downloads use the guarded filesystem without the RPC preview cap", async () => {
  const state = { nodeOrigin: "local", provider: "local", remoteReads: 0 };
  Object.assign(globalThis, { __cohubDownloadTest: state });
  const sources: Record<string, string> = {
    "./config.js": "export const config = globalThis.__cohubDownloadTest;",
    "./space-fs.js": "export const assertSafeRelativePath=x=>x; export class SpaceFsError extends Error {} export const ensureSpaceWorkspaceReady=()=>{}; export const getMimeType=()=>{}; export const sanitizeFileName=x=>x; export const spaceFsJsonError=()=>{}; export const streamSpaceFile=()=>{};",
    "./space-fs-remote.js": "export async function downloadSpaceFile() { globalThis.__cohubDownloadTest.remoteReads++; return {name:'file.zip',mimeType:'application/zip',buffer:Buffer.from([0,255])}; }",
    "./space-sandboxes.js": "export async function getSpaceSandboxBySpaceId() { return {provider:globalThis.__cohubDownloadTest.provider}; }",
    "@cohub/sandbox-controller": "export const isSandboxDialable=()=>false;",
    "./sandbox-fs-mutation-queue.js": "export const enqueueSandboxFsMutationJob=()=>{}; export class SandboxFsMutationTimeoutError extends Error {}",
  };
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (!context.parentURL?.includes("/space-fs-backend.ts") || !sources[specifier]) return next(specifier, context);
    return { url: `data:text/javascript,${encodeURIComponent(sources[specifier])}`, shortCircuit: true };
  } });
  try {
    const { resolveSpaceFileDownload } = await import("./space-fs-backend.js");
    const options = { visibility: "full" as const };
    assert.deepEqual(await resolveSpaceFileDownload("managed", "file.zip", options), { kind: "local", spaceId: "managed", path: "file.zip", options });
    assert.equal(state.remoteReads, 0, "installed files must not use the 10 MiB RPC preview reader");
    state.nodeOrigin = "cloud";
    const remote = await resolveSpaceFileDownload("remote", "file.zip", options);
    assert.equal(remote.kind, "buffer");
    assert.equal(state.remoteReads, 1, "cloud APIs must still access personal devices through RPC");
    state.provider = "cloud";
    assert.equal((await resolveSpaceFileDownload("cloud", "file.zip", options)).kind, "cloud");
    assert.equal(state.remoteReads, 1);
  } finally {
    hooks.deregister();
    Reflect.deleteProperty(globalThis, "__cohubDownloadTest");
  }
});
