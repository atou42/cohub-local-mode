import { RTC_HELPER_VERSION } from "../src/commands/rooms-rtc-binary.js";

if (!/^v\d+\.\d+\.\d+$/.test(RTC_HELPER_VERSION)) throw new Error("Pin RTC_HELPER_VERSION to a published global release before publishing the CLI");

const base = (process.env.COHUB_RTC_CDN_BASE_URL || "https://public.cohub.live/rtc").replace(/\/+$/, "");
await Promise.all(["linux_amd64", "linux_arm64", "darwin_amd64", "darwin_arm64"].map(async (target) => {
  const url = `${base}/${RTC_HELPER_VERSION}/cohub-rtc_${target}.gz`;
  const signal = AbortSignal.timeout(30_000);
  const manifest = await fetch(`${url}.sha256`, { signal });
  if (!manifest.ok || !/^[a-f0-9]{64}(?:\s|$)/.test(await manifest.text())) throw new Error(`Publish RTC helper ${RTC_HELPER_VERSION} for ${target} before publishing the CLI`);
  const binary = await fetch(url, { method: "HEAD", signal });
  if (!binary.ok) throw new Error(`RTC helper binary is unavailable for ${target}`);
}));
console.log(`RTC helper ${RTC_HELPER_VERSION} is available for all supported platforms`);
