import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const QUOTA = { total: 4, perViewer: 1, freshMs: 90_000 } as const;
export type QuotaRefusal = "SPIRIT_BUSY" | "SPIRIT_ALREADY_AWAKE";

const CLAIM = `
import { readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
const [dir, file, viewer, owner, total] = process.argv.slice(1);
const viewers = [];
for (const name of readdirSync(dir)) {
  if (!name.endsWith(".json")) continue;
  const path = join(dir, name);
  let entry;
  try { entry = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") continue;
    viewers.push(null); // Malformed occupancy counts, never bypasses the cap.
    continue;
  }
  if (Number.isInteger(entry.pid) && entry.pid > 0) {
    try { process.kill(entry.pid, 0); }
    catch (error) {
      if (error.code === "ESRCH") { rmSync(path, { force: true }); continue; }
    }
  }
  viewers.push(entry.viewer);
}
if (viewer && viewers.includes(viewer)) console.log("SPIRIT_ALREADY_AWAKE");
else if (viewers.length >= Number(total)) console.log("SPIRIT_BUSY");
else writeFileSync(file, JSON.stringify({ viewer, pid: Number(owner) }));
`;

export class Quota {
  private readonly file: string;

  constructor(run: string, private readonly viewer: string, private readonly dir = join(tmpdir(), "ember-spirits")) {
    this.file = join(dir, `${run}.json`);
  }

  claim(): QuotaRefusal | null {
    mkdirSync(this.dir, { recursive: true });
    const result = spawnSync("flock", [
      "-n", "-E", "75", join(this.dir, ".claim.lock"),
      process.execPath, "--input-type=module", "-e", CLAIM,
      this.dir, this.file, this.viewer, String(process.pid), String(QUOTA.total),
    ], { encoding: "utf8", timeout: 5000 });
    if (result.status === 75) return "SPIRIT_BUSY";
    if (result.error || result.status !== 0) throw new Error("Could not acquire spirit quota.");
    const refusal = result.stdout.trim();
    if (!refusal) return null;
    if (refusal === "SPIRIT_BUSY" || refusal === "SPIRIT_ALREADY_AWAKE") return refusal;
    throw new Error("Invalid spirit quota response.");
  }

  beat() {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ viewer: this.viewer, pid: process.pid }));
    renameSync(temporary, this.file);
  }

  release() {
    rmSync(this.file, { force: true });
  }
}
