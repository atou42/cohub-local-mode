const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function creationTime(value) {
  if (typeof value !== "string") return NaN;
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/);
  if (!parts) return NaN;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = parts;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (
    !Number.isFinite(calendar.getTime()) ||
    calendar.toISOString().slice(0, 10) !== `${year}-${month}-${day}` ||
    Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
    Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59
  ) return NaN;
  return Date.parse(value);
}

// Validate every entry before selecting the current deployment, including singleton lists.
export function readReleaseSnapshot(deployments, name) {
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error(`${name}: Cloudflare returned no deployments`);
  }
  const validated = deployments.map((deployment) => {
    const time = creationTime(deployment?.created_on);
    if (!Number.isFinite(time)) throw new Error(`${name}: invalid deployment created_on`);
    const versions = deployment?.versions;
    if (!Array.isArray(versions) || versions.length === 0) {
      throw new Error(`${name}: missing deployment versions`);
    }
    const ids = new Set();
    let total = 0;
    for (const version of versions) {
      if (typeof version?.version_id !== "string" || !uuid.test(version.version_id) || ids.has(version.version_id.toLowerCase())) {
        throw new Error(`${name}: invalid or duplicate version_id`);
      }
      if (typeof version.percentage !== "number" || !Number.isFinite(version.percentage) || version.percentage <= 0 || version.percentage > 100) {
        throw new Error(`${name}: invalid deployment percentage`);
      }
      ids.add(version.version_id.toLowerCase());
      total += version.percentage;
    }
    if (Math.abs(total - 100) > 1e-8) throw new Error(`${name}: deployment percentages do not total 100`);
    return { deployment, time };
  }).sort((a, b) => b.time - a.time);
  if (validated.length > 1 && validated[0].time === validated[1].time) {
    throw new Error(`${name}: ambiguous latest deployment created_on`);
  }
  const current = validated[0].deployment;
  if (current.versions.length !== 1 || current.versions[0].percentage !== 100) {
    throw new Error(`${name}: latest deployment must have one version at 100%`);
  }
  const message = current.annotations?.["workers/message"];
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new Error(`${name}: latest deployment has no workers/message`);
  }
  return { versionId: current.versions[0].version_id, message };
}

export async function recoverRelease({ targets, run, readCurrent, originalError, failedStage }) {
  const outcomes = [];
  const failures = [];
  for (const target of [...targets].reverse()) {
    let phase = "not attempted";
    let currentVersionId = "unknown";
    let restorationOutput;
    try {
      if (!target.attempted) {
        outcomes.push(`${target.name} old=${target.previous.versionId} not attempted`);
        continue;
      }
      phase = "inspect";
      const current = await readCurrent(target);
      currentVersionId = current.versionId;
      if (current.versionId === target.previous.versionId) {
        outcomes.push(`${target.name} old=${target.previous.versionId} already unchanged`);
        continue;
      }
      if (current.message !== target.message || (target.deployedVersionId && current.versionId !== target.deployedVersionId)) {
        throw new Error(`third-party deployment ${current.versionId}; refusing to overwrite`);
      }
      phase = "rollback";
      // Unlike `rollback`, explicit versions deploy does not force changed secrets.
      restorationOutput = await run("pnpm", [
        ...target.prefix, "versions", "deploy", `${target.previous.versionId}@100`,
        "--config", target.config, "--message", target.previous.message,
      ], { ...target.options, capture: true });
      phase = "verify rollback";
      const restored = await readCurrent(target);
      currentVersionId = restored.versionId;
      if (restored.versionId !== target.previous.versionId || restored.message !== target.previous.message) {
        throw new Error(`old deployment not restored; current=${restored.versionId}`);
      }
      outcomes.push(`${target.name} old=${target.previous.versionId} restored and verified`);
    } catch (error) {
      failures.push(error);
      const evidence = [error, restorationOutput].flatMap((result) =>
        ["stdout", "stderr"].flatMap((stream) => {
          const value = result?.[stream];
          return typeof value === "string" && value.trim() ? [`${stream}: ${value.trim()}`] : [];
        }),
      );
      outcomes.push(`${target.name} old=${target.previous.versionId} current=${currentVersionId} not restored at ${phase}: ${error instanceof Error ? error.message : String(error)}${evidence.length ? ` (${evidence.join("; ")})` : ""}`);
    }
  }
  throw new AggregateError(
    [originalError, ...failures],
    `Local Mode release failed at ${failedStage}: ${originalError instanceof Error ? originalError.message : String(originalError)}. Recovery: ${outcomes.join("; ")}`,
    { cause: originalError },
  );
}
