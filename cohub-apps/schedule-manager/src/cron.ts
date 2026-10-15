const parser = () => import("cron-parser").then((module) => module.CronExpressionParser);

export type CronPreview =
  | { ok: true; runs: Date[]; timezone: string }
  | { ok: false; reason: "fields" | "expression" | "timezone" | "interval" };

export function validTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export async function previewCron(
  expression: string,
  timezone: string,
  count = 3,
): Promise<CronPreview> {
  const value = expression.trim();
  if (value.split(/\s+/).length !== 5) return { ok: false, reason: "fields" };
  if (!validTimezone(timezone.trim())) return { ok: false, reason: "timezone" };
  try {
    const interval = (await parser()).parse(value, { tz: timezone.trim() });
    const runs = interval.take(Math.max(2, count)).map((date) => date.toDate());
    const [first, second] = runs;
    if (first && second && second.getTime() - first.getTime() < 60_000)
      return { ok: false, reason: "interval" };
    return { ok: true, runs: runs.slice(0, count), timezone: timezone.trim() };
  } catch {
    return { ok: false, reason: "expression" };
  }
}

export const CRON_PRESETS = [
  { id: "hourly", expression: "0 * * * *" },
  { id: "daily", expression: "0 9 * * *" },
  { id: "weekdays", expression: "0 9 * * 1-5" },
  { id: "weekly", expression: "0 9 * * 1" },
] as const;
