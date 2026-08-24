import { resolve } from "node:path";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function managedWorkspacePath(storageRoot, spaceId) {
  if (!UUID_PATTERN.test(spaceId)) {
    throw new Error(`invalid local Space id: ${spaceId}`);
  }
  return resolve(storageRoot, spaceId, "workspace");
}

function reportExitMessage(result) {
  if (result.signal) return `local sandbox runner exited with ${result.signal}`;
  return `local sandbox runner exited with code ${result.code ?? "unknown"}`;
}

function reportStartupMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return `local sandbox runner failed to start: ${message}`;
}

function reportedAtMillis(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class ManagedSandboxSupervisor {
  constructor(options) {
    this.storageRoot = resolve(options.storageRoot);
    this.listSpaces = options.listSpaces;
    this.startRunner = options.startRunner;
    this.reportStatus = options.reportStatus;
    this.ensureDirectory = options.ensureDirectory;
    this.now = options.now ?? Date.now;
    this.retryDelayMs = options.retryDelayMs ?? 5_000;
    if (!Number.isFinite(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw new Error("retryDelayMs must be a non-negative finite number");
    }
    this.startedAt = options.startedAt ?? this.now();
    this.runners = new Map();
    this.failedUntil = new Map();
    this.pendingReports = new Set();
    this.reconcilePromise = null;
    this.stopping = false;
  }

  reconcile() {
    if (this.stopping) return Promise.resolve();
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.reconcileOnce().finally(() => {
      this.reconcilePromise = null;
    });
    return this.reconcilePromise;
  }

  async reconcileOnce() {
    if (this.pendingReports.size > 0) {
      await Promise.allSettled([...this.pendingReports]);
    }
    const spaces = await this.listSpaces();
    const desiredIds = new Set(spaces.map((space) => space.spaceId));

    for (const [spaceId, entry] of this.runners) {
      if (desiredIds.has(spaceId)) continue;
      this.runners.delete(spaceId);
      this.failedUntil.delete(spaceId);
      entry.child.stop();
    }
    for (const spaceId of this.failedUntil.keys()) {
      if (!desiredIds.has(spaceId)) this.failedUntil.delete(spaceId);
    }

    for (const space of spaces) {
      if (this.runners.has(space.spaceId)) continue;
      const retryAt = this.failedUntil.get(space.spaceId);
      if (retryAt !== undefined && retryAt > this.now()) continue;
      this.failedUntil.delete(space.spaceId);
      const lastReportedAt = reportedAtMillis(space.reportedAt);
      if (
        (space.status === "ready" || space.status === "running") &&
        lastReportedAt !== null &&
        lastReportedAt >= this.startedAt
      ) {
        continue;
      }
      await this.startSpace(space.spaceId);
    }
  }

  async startSpace(spaceId) {
    const workspaceDir = managedWorkspacePath(this.storageRoot, spaceId);
    let child;
    try {
      await this.ensureDirectory(workspaceDir);
      await this.reportStatus({ spaceId, status: "provisioning", message: null });
      child = await this.startRunner({ spaceId, workspaceDir });
    } catch (error) {
      this.failedUntil.set(spaceId, this.now() + this.retryDelayMs);
      await this.reportStatus({
        spaceId,
        status: "error",
        message: reportStartupMessage(error),
      });
      return;
    }
    this.failedUntil.delete(spaceId);
    const entry = { child };
    this.runners.set(spaceId, entry);
    child.onExit((result) => {
      if (this.runners.get(spaceId) !== entry) return;
      this.runners.delete(spaceId);
      if (this.stopping || result.relinquished === true) return;
      this.failedUntil.set(spaceId, this.now() + this.retryDelayMs);
      const pending = Promise.resolve(
        this.reportStatus({
          spaceId,
          status: "error",
          message: reportExitMessage(result),
        }),
      ).finally(() => this.pendingReports.delete(pending));
      this.pendingReports.add(pending);
    });
  }

  async stop() {
    this.stopping = true;
    if (this.reconcilePromise) await this.reconcilePromise;
    for (const entry of this.runners.values()) entry.child.stop();
    this.runners.clear();
    if (this.pendingReports.size > 0) {
      await Promise.allSettled([...this.pendingReports]);
    }
  }
}
