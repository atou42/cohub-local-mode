import { Socket } from "node:net";

const connect = Socket.prototype.connect;
const loopbackPorts = new Set();

export function allowLoopbackPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("A bound test server port is required");
  }
  loopbackPorts.add(port);
  return () => loopbackPorts.delete(port);
}

if (process.env.COHUB_TEST_ALLOW_NETWORK !== "1") {
  Socket.prototype.connect = function guardedConnect(...args) {
    const normalized = Array.isArray(args[0]) ? args[0] : args;
    const options = typeof normalized[0] === "object"
      ? normalized[0]
      : { port: normalized[0], host: normalized[1] };
    if (options?.host === "127.0.0.1" && loopbackPorts.has(Number(options.port))) {
      return connect.apply(this, args);
    }
    throw new Error(
      "Network access is disabled in unit tests; inject an in-memory fake instead",
    );
  };
}
