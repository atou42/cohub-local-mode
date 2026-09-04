# Connector Agent Readiness Ledger

## Goal

Make the dev-cohub Mac Connector a stable, cache-first local Agent entry point. Pi ships with the Connector and remains ready by default. Codex, Grok Build, and Cursor remain visible in the chat selector, but unavailable harnesses are locked with an inline installation or sign-in action. Missing or broken harnesses must not delay the selector, model loading, or another harness. Reconnects and rapid retries must not lose Sessions or create competing Codex writers.

## Constraints

- Keep the existing chat surface and Session harness lock. Do not add a settings page.
- Preserve local workspace data, native Agent sessions, Cloud Spaces, generation, and the working Mac mini flow.
- Do not hide discovery failures or replace a broken catalog with another harness's models.
- Cache only validated server responses. A stale readiness result may render immediately, but must refresh without blocking interaction.
- Production `cohub.atou.cc` remains untouched unless a separately authorized deployment changes it.

## Current Evidence

- The MacBook Connector log from 2026-09-04 contains 573 concurrent-command rejections before the Alpha 2 update. The Alpha 2 relay reconnect has no recurrence and reaches its connected state in about five seconds, while the bundled local services remain the slower startup stage.
- Cursor discovery fails with `Device not configured (os error 6)` and Grok Build has no model catalog on the MacBook. The previous web selector still offered both as if they were ready.
- A Codex resume started seven seconds after the previous sandbox peer closed, while sandbox-owned processes were only cleaned after a 30-second grace period. `thread/resume` failed because the native thread still had an active writer. No database deletion or Connector crash appears in the log.
- Pi runs inside the packaged Cohub Agent service through `@earendil-works/pi-agent-core`; it does not require a separately installed host CLI.
- The packaged API previously spent about 45 seconds loading its ESM telemetry hook before configuration checks, versus about 15 seconds without the hook. The Connector runtime does not export that module-level telemetry, so its local API now starts without the hook while retaining application tracing.

## Design Decision

Use the existing compact Agent selector in utility mode. All four harnesses stay visible. Each row carries one concise state. Ready rows select normally. Unavailable rows are disabled and expose a short inline action in the same popover. Readiness is a separate local-node contract so model errors are not overloaded as installation state.

## Validation Ledger

- Added a typed `/api/harness-readiness` contract. Pi is always bundled and ready. Codex, Grok Build, and Cursor are classified from executable, credential, and validated catalog evidence. The server coalesces checks and caches them for five minutes.
- Added a user-partitioned browser cache with validated shape, five-minute background refresh, and a 24-hour stale ceiling. Cached state renders before the network check.
- The existing Agent popover now keeps all four harnesses visible. Unavailable external harnesses remain selected-disabled and expand an inline install, sign-in, or repair action. Pi remains usable when another harness is absent.
- Added Codex active-writer retry with visible status on the same native thread. Runtime replacement first aborts the old sandbox process and allows it to close before a new writer starts.
- Connector shutdown now drains API, gateway, and queue processes before Redis and Postgres. A process-level shutdown smoke test showed workers pause first, databases stop afterward, and no Redis connection errors occur.
- Removed the unused desktop API ESM instrumentation hook and enabled Node's persistent compile cache. The isolated packaged runtime improved from about 71 seconds to 47 seconds on the first measured start and 33 seconds on the next start.
- Focused verification passed: 10 API catalog/readiness tests, 5 browser cache/selector tests, 2 Codex resume tests, 4 desktop recovery tests, desktop typecheck, SDK typecheck, web typecheck, protocol tests, source formatting, and diff integrity.
- `dev-cohub.atou.cc` is running the readiness-aware web build as Cloudflare Worker version `507fce33-361d-4ce7-b3a9-50036d29d222`. Production `cohub.atou.cc` was not changed.
- Packaged `Cohub-Connector-0.2.0-alpha.4-arm64.dmg` is 313,791,507 bytes with SHA-256 `8c37086a1d444e439197acdbafaa17d3cebfba666b3b6148c587a71d1397129d`. The disk image checksum, app signature, app version, and embedded runtime checksum all passed.
- Uploaded Alpha 4 to the user's Feishu Drive and sent the download link to the confirmed `阿头` direct chat as the authorized user identity. The delivered message id is `om_x100b669148e070a8c07f9ac8e6d91b8`.

## Blockers

Final MacBook acceptance still requires installing Alpha 4 on that machine. Local verification cannot prove the real MacBook's host credentials, Cursor first-run state, or a live Codex resume against its existing Sessions.

## Next Action

Install the delivered Alpha 4 build on the MacBook, verify the selector states against that machine, send one Pi turn, send one installed external-harness turn, and retry a Codex Session while the previous writer is closing. Preserve the Connector log if any step fails.
