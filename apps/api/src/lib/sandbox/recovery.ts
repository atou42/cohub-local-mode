import { Writable } from "node:stream";
import type { V1Status } from "@kubernetes/client-node";
import { getKubernetesClients } from "../../k8s.js";

export type SandboxInfraErrorCode = "STALE_MOUNT" | "CRITICAL_MOUNT_IO";

const CRITICAL_MOUNT_PREFIXES = [
  "/workspace",
  "/configs/platform/.agents",
  "/configs/user/.agents",
  "/sessions",
  "/public",
];

const DEFINITIVE_STALE_MOUNT_PATTERNS = [
  "stale nfs file handle",
  "stale file handle",
  "estale",
];

const DEFINITIVE_CRITICAL_IO_PATTERNS = [
  "input/output error",
  "i/o error",
  "transport endpoint is not connected",
];

const normalize = (value: string) => value.toLowerCase();

export const classifySandboxInfraError = (message: string): {
  code: SandboxInfraErrorCode;
  requiresPodRecreate: true;
  mountPath?: string;
} | null => {
  const normalized = normalize(message);
  const mountPath = CRITICAL_MOUNT_PREFIXES.find((prefix) => normalized.includes(prefix.toLowerCase()));
  if (!mountPath) return null;

  if (DEFINITIVE_STALE_MOUNT_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return { code: "STALE_MOUNT", requiresPodRecreate: true, mountPath };
  }

  // Treat ENOENT/ENOTDIR-style failures as ordinary path mistakes unless the
  // message contains a more definitive mount failure signal.
  if (DEFINITIVE_CRITICAL_IO_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return { code: "CRITICAL_MOUNT_IO", requiresPodRecreate: true, mountPath };
  }

  return null;
};

export const isSandboxInfraError = (message: string) => classifySandboxInfraError(message) !== null;

const getObjectString = (value: unknown, key: string): string | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
};

const describeUnknownError = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) return error.message;

  const directMessage = getObjectString(error, "message");
  if (directMessage) return directMessage;

  const nestedError = error && typeof error === "object" ? (error as Record<string, unknown>).error : null;
  if (nestedError instanceof Error && nestedError.message.trim()) return nestedError.message;

  const nestedMessage = getObjectString(nestedError, "message");
  if (nestedMessage) return nestedMessage;

  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") return serialized;
  } catch {
    // ignore JSON serialization failures and fall back to String below
  }

  return String(error);
};

const toExecError = (error: unknown) => new Error(describeUnknownError(error));

export const smokeVerifySandboxPod = async (podName: string, namespace: string, timeoutMs = 45_000) => {
  const script = [
    "set -eu",
    "stat /workspace >/dev/null",
    "stat /sessions >/dev/null",
    "stat /public >/dev/null",
    "printf ok > /tmp/.cohub-healthcheck",
    "grep -q ok /tmp/.cohub-healthcheck",
    "printf '{\"workspace\":true,\"sessions\":true,\"public\":true,\"tmp\":true}'",
  ].join("\n");

  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const output = await execInSandboxPod(namespace, podName, script, Math.min(10_000, Math.max(1000, deadline - Date.now())));
      const jsonStart = output.indexOf("{");
      if (jsonStart < 0) throw new Error(`smoke verify returned no json: ${output}`);
      return JSON.parse(output.slice(jsonStart)) as Record<string, boolean>;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw toExecError(lastError);
};

const execInSandboxPod = (namespace: string, podName: string, script: string, timeoutMs: number) => {
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let socket: { close: () => void } | null = null;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(`${stdout}${stderr ? `\n${stderr}` : ""}`.trim());
    };

    const timer = setTimeout(() => {
      socket?.close();
      finish(new Error(`kubernetes exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const stdoutStream = new Writable({
      write(chunk, _encoding, callback) {
        stdout += chunk.toString();
        callback();
      },
    });
    const stderrStream = new Writable({
      write(chunk, _encoding, callback) {
        stderr += chunk.toString();
        callback();
      },
    });

    void getKubernetesClients().then(({ k8sExec }) => {
      if (settled) return;
      return k8sExec.exec(
        namespace,
        podName,
        "sandbox",
        ["sh", "-lc", script],
        stdoutStream,
        stderrStream,
        null,
        false,
        (status: V1Status) => {
          const exitCode = status.details?.causes?.find((cause) => cause.reason === "ExitCode")?.message;
          if (status.status === "Success" || exitCode === "0") {
            finish();
            return;
          }
          const message = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
          finish(new Error(`kubernetes exec failed${exitCode ? ` with code ${exitCode}` : ""}: ${message || status.message || status.reason || "unknown error"}`));
        },
      ).then((ws) => {
        if (settled) { ws.close(); return; }
        socket = ws;
        ws.on("error", (error: unknown) => finish(toExecError(error)));
      });
    }).catch((error: unknown) => {
      finish(toExecError(error));
    });
  });
};
