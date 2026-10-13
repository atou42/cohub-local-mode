# WorkBuddy Local validation — 2026-10-13

## Verified against the installed application

WorkBuddy 5.3.14 / bundled CLI 2.115.0 is installed and signed in. The explicit real-account smoke passed using synthetic prompts only:

- Discovers 18 native models and the native default.
- Creates a native conversation, reads its saved history, and delivers the exact reply to the local in-memory ingestion receiver. A separate completed-job recheck imports one batch initially and zero on repeat; source bytes remain unchanged.
- Executes a new Cohub turn with streamed text and a durable native receipt.
- Continues the same Cohub conversation in a private native copy and recalls the exact random token from the previous turn. The source transcript remains byte-identical.
- Stops after the first visible text delta, preserves the received partial text, and confirms its child process group has exited.
- Real synthetic histories also pass discovery, parsing, replay deduplication and a later desktop-turn synchronization with the correct session and parent.
- Desktop and 390-pixel mobile component previews both expose WorkBuddy, select its default model and open its model picker. The previews use fixture status, not a production connection.

Run the opt-in real-account smoke from `packages/cli` with `COHUB_NATIVE_WORKBUDDY_SMOKE=1 node --import tsx tests/runtime-workbuddy.smoke.ts`. It sends four synthetic prompts through the existing WorkBuddy account, may consume that account's allowance, does not upload to Cohub cloud, and preserves its report and native test histories.

## Regressions and compatibility

- 65 focused CLI tests cover WorkBuddy, lifecycle, new-harness import consent and reattachment errors. New fixes were reproduced by failing tests before implementation.
- Real WorkBuddy records may reuse one native ID for assistant text and multiple tool calls. All events and their results are retained, while genuine updates replace only the matching event.
- Appended complete records trigger live previews. Corrupt headers and unfinished historical tails report explicit errors; finished turns remain imported and retries do not duplicate them.
- Adding WorkBuddy to existing Pi/Codex sync asks about only newly added history. Existing consent is preserved; corrupt configuration and reattachment failures are not replaced or hidden.
- Saved explicit direct mode is applied before starting WorkBuddy, so inherited stale proxy settings cannot become Node's startup proxy snapshot. Parent Runtime settings remain unchanged. Missing settings use the existing environment; corrupt settings fail explicitly.
- Protocol: 189 tests. SDK runtime: 2. Core prompt model validation: 3. Background queue: 4. Web model selection/status: 14. All passed on the implementation base.
- 33 existing native transcript/archive/projection tests, 16 execution/recovery/batching tests, and 10 native ingestion tests passed on the implementation base with `TMPDIR=/private/tmp`.
- CLI build and CLI/protocol/SDK/infrastructure/web typechecks passed on the implementation base. Web reported zero errors and warnings. Changed-code lint passed.

The existing Pi smoke requires the canonical macOS temporary path. `/tmp` and long temporary socket paths caused Pi attachment failures independently of this feature; the failure/pass pair was also reproduced at base commit `4d30d49`.

## Network acceptance

The original desktop report failed against unavailable inherited proxy `127.0.0.1:7890`. Setting direct mode alone left a startup proxy snapshot active. A clean launch and scoped VPN direct rules resolved it. WorkBuddy's own 12:00:30 network report passed all checks: No Proxy, HTTP OK in 127 ms, TCP in 8 ms and zero packet loss. The subsequent real-account smoke passed through Cohub's launch implementation without an external proxy-cleaning wrapper.

## Remaining boundaries

- No production Cohub history upload, cloud deployment or real-Space cross-device acceptance was performed. Synchronization was verified against the local in-memory receiver using actual synthetic native records.
- WorkBuddy desktop-held conversations are not controlled concurrently. Cohub continues through private copies, retains the same cloud conversation, and does not promise those copies appear automatically in the desktop list.
- Native incomplete/error records alone cannot establish a whole turn's terminal state because WorkBuddy may retry. Unfinished historical tails fail explicitly instead of being silently omitted or uploaded as running tasks.
- System-message projection is accepted by native resume; its model-context effect has not been separately measured. macOS automatic discovery is verified; other systems require explicit executable paths and were not exercised.
- Broader server checks remain blocked by unavailable private dependencies/build exports in this checkout. Fully provisioned CI must run them.
