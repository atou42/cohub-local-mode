import { spawn } from "node:child_process";
import { constants } from "node:os";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const satisfies readonly NodeJS.Signals[];

export function exitCodeForChild(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (!signal) return 1;
  return 128 + (constants.signals[signal] ?? 1);
}

export function relaunchCli(
  entrypoint: string,
  argv: string[],
  options?: { execArgv?: readonly string[] },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(options?.execArgv ?? []), entrypoint, ...argv], {
      env: process.env,
      stdio: "inherit",
    });

    const signalHandlers = FORWARDED_SIGNALS.map((signal) => {
      const forward = () => {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      };
      process.on(signal, forward);
      return [signal, forward] as const;
    });
    const cleanup = () => {
      for (const [signal, forward] of signalHandlers) process.off(signal, forward);
    };

    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      resolve(exitCodeForChild(code, signal));
    });
  });
}
