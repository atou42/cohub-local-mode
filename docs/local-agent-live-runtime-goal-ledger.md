# Local Agent Live Runtime Goal Ledger

## Goal contract

Upgrade Local Mode so Pi, Codex, and Grok Build expose a persisted, reconnectable live execution timeline instead of leaving the user without feedback until a turn ends. Queueing, startup, thinking, tool activity, command output, warnings, retries, recovery, authorization or quota failures, and terminal state must be visible after redaction. Recoverable errors must not override a later successful completion. Warm harness runtime reuse must remove per-turn cold startup where the harness supports it. Preserve Local and Cloud Space routing, immutable harness choice after the first turn, model and effort selection, permissions, files, tools, history, the Cloudflare HTTP/2 Tunnel, and Pi behavior. Do not change the global AGENTS content, model catalogs, or provider network policy.

Completion requires real Pi, Codex, and Grok Build runs plus failure probes. The UI must show an actual state within one second of submission; received live events must become visible within 500 milliseconds; warm-session harness startup overhead must have p95 below one second. Refresh and reconnect must restore the timeline. Credentials and environment secrets must not appear in persisted or rendered output.

## 2026-08-25 baseline and confirmed defects

Status: complete.

The worktree already contains the confirmed Local Mode connectivity, harness catalog, Cloudflare relay, attachment, and HTTP/2 Tunnel changes. Those changes are part of the baseline and must not be reverted. No remote push or pull request is authorized.

Codex false-failure evidence is preserved in local Session `50a6e90b-beeb-4c78-a2e2-dad38e6fc67f`. The sandbox process started at 15:01:13 and exited zero at 15:02:19. Codex rollout `01a037b9-e16e-7710-ab8b-d14ea64c28f7` contains a final assistant message and `task_complete`, but Cohub displayed `Reconnecting... 2/5` as the terminal error. `HarnessEventReducer` currently makes every Codex `error` event permanently fatal even when a later `turn.completed` proves success.

The affected Space is only 8 KB and its sandbox was already ready. Sandbox attachment took about 0.7 seconds. The Codex process then spent roughly 52 seconds establishing or recovering its upstream stream and 13.6 seconds to first model output. The turn loaded 27,341 input tokens, including the existing global AGENTS instructions; changing those instructions is outside this goal.

External Codex and Grok Build execution currently starts a fresh CLI process for every turn and buffers JSONL until process exit. No external-harness intermediate event is persisted or published to the browser. Pi has a richer internal event stream, but the current persisted conversation surface does not provide one uniform durable runtime timeline across all three harnesses.

Agents in Discord currently keeps Codex app-server processes alive per thread and publishes progress while work runs. Local Mode must adopt the relevant lifecycle and visibility properties without coupling the Cohub product to Discord.

## 2026-08-25 event contract mapping

The existing session contract can carry the live timeline without a new database table. `session.turn.patch` plus the Redis stream snapshot already provides reconnectable active content. Intermediate `sessionMessages` already provide durable per-turn history, and turn finalization already archives those messages into the intermediate index used by `ProcessCard`. The browser already merges live patches, persisted intermediate messages, and restored server snapshots.

Pi already projects text, thinking, tool start, tool updates, and tool end into this contract. Codex and Grok Build bypass it: their JSONL reducer only returns an aggregate after process exit. The smallest shared implementation is therefore to make external harnesses publish the same `ContentBlock` snapshot while running, persist coherent intermediate boundaries, and preserve provider-specific raw event detail in redacted metadata rather than creating another transport and UI path.

The confirmed false-failure now has a red-green regression. A Codex `error` event is retained as a recoverable stream failure unless the stream ends without completion; an explicit `turn.failed` remains terminal. A later `turn.completed` with final content now wins over a prior reconnect warning.

## 2026-08-25 live runtime implementation

Codex and Grok Build now produce normalized redacted `ContentBlock` snapshots while they run. The processor publishes those snapshots through the existing turn patch stream, then persists intermediate runtime content before the final answer. Runtime notes cover preparation, sandbox attachment, process readiness, thinking, tools, command output, stderr, retries, recovery, permission decisions, completion, and unknown provider events. Secret-shaped fields, bearer tokens, JWTs, API key assignments, and known token prefixes are redacted before metadata is rendered or stored.

The Local Sandbox protocol now supports owner-checked `process.write`, including stdin closure and a one MiB per-write limit. The Go process manager has a real stdin round-trip test plus a wrong-owner rejection test. Protocol typecheck and the affected Go process, RPC, and WebSocket tests pass.

Codex now uses one warm `codex app-server` process per Space Session when the sandbox advertises `processWrite`. Grok Build now uses one warm `grok agent stdio` ACP process per Space Session. Both have a fifteen-minute idle lifetime, bounded idle eviction, session resume, per-turn model and effort configuration, cancellation, startup timing metadata, and a one-shot compatibility path for older sandboxes. A direct real Codex app-server probe completed with `CODEX_RUNTIME_OK`; it exposed the TLS WebSocket failure on stderr, recovered through the provider path, streamed text deltas, and ended successfully.

Pi keeps its existing warm in-process session and now turns retryable provider failures into redacted persisted warning events. The next attempt publishes a recovery event instead of silently replacing the failed attempt. Existing Pi start, thinking, text, and tool lifecycle behavior remains on the shared session stream.

The browser now renders runtime events as compact inline timeline rows. Raw redacted provider detail is available behind an accessible disclosure control. The presentation uses existing Cohub tokens and Process timeline structure, remains full-width on mobile, and avoids a new nested card surface.

Terminal formatting sequences are removed before new runtime events are persisted and again at render time, so older stored events are also readable. Provider failures remain visible as warning rows without leaking terminal color bytes into the UI.

## 2026-08-25 real acceptance evidence

Codex success and recovery were verified in Session `02757b9f-c6c2-45c8-9270-6539e8615f7e`. Turn `45c45b24-68a2-4251-bfae-c035a4ddde09` ran a real shell command from the bound local workspace, exposed recoverable MCP and TLS failures, showed the successful tool result, and completed with the exact final text `CODEX_VERIFIED_FINAL_OK`. Submission acknowledgement took 583 milliseconds. Warm Turn `41712fd6-346e-4570-bd11-6dee997ac2d4` reused the same Codex runtime, acknowledged in 429 milliseconds, displayed its first runtime block in 705 milliseconds, and completed successfully.

Grok Build was verified in Session `8f85eac2-58e5-46dd-a19a-4f1d24d9b757`. Turn `33382ce2-c06e-4040-a5b8-da9b90b192ab` completed a real shell tool call and Turn `ac07ebb0-8175-445f-b5d3-7803ffb0d3dd` reused the warm ACP runtime with one millisecond of recorded harness startup overhead. The earlier workspace failure and retry remain visible rather than being replaced by the later success. The warm probe acknowledged in 207 milliseconds and exposed its first snapshot in 233 milliseconds.

Pi was verified in Session `3d3e7213-124a-4202-98db-d43267377d0b`. Turn `1ff454f5-7953-4254-91ee-5e00e0520856` completed a real bash tool call. Turn `bbc1de97-84a3-4424-a140-ae70965f1254` ran an intentional exit-code-7 failure, exposed stderr and the failed tool state, and then produced the correct final report. Pi's existing warm in-process lifecycle remained intact.

The observed warm-runtime startup samples are below the one-second requirement. All direct submission acknowledgements and first received runtime snapshots measured during the acceptance probes met the one-second and 500-millisecond targets respectively, except the Codex warm browser-visible block which measured 705 milliseconds from submission while still meeting the one-second actual-state target. Received-event rendering itself remained below 500 milliseconds once the event arrived.

## 2026-08-25 durability and public UI acceptance

Persisted intermediate messages are now available through the authenticated per-turn API even when the optional object archive is unavailable. This matters on the current Mac mini because its disk is close enough to full for MinIO to reject new archive objects. The database remains authoritative, and the public UI restored the complete Codex process timeline after a hard refresh and after an offline-to-online reconnect with no `Load failed` state.

The public Local Mode Worker was deployed as version `cf8b1595-d950-4d01-85bd-6a80f0b842bb`. The authenticated page loaded entry `start.BvqPzwG9.js`; expanding the process fetched the persisted intermediate endpoint with HTTP 200 and showed preparation, sandbox connection, provider failures, tool activity, terminal state, and final answer. Desktop at 1440 by 1000 and mobile at 430 by 932 were inspected with the process expanded. Content remained readable, contained no ANSI artifacts, and did not overlap the composer or navigation.

A value-based scan compared eight configured secret values against the persisted Pi, Codex, and Grok Build acceptance sessions and the rendered public page. No secret appeared in either surface. Four local object-store access identifiers were deliberately excluded because they are identifiers rather than secrets; none appeared in the rendered page.

Focused agent tests passed 16 of 16, Local Relay passed 11 of 11, the affected Go process and RPC tests passed, and the affected API tests passed. Protocol, Sandbox Client, SDK, and Web typechecks passed; Web reported zero diagnostics. Biome checked all 48 changed TypeScript, Svelte, and JavaScript files with no findings. The production build completed, and Local Mode, its service, Postgres, Redis, object store, API, gateway, web app, private ingress, Cloudflare relay node, and Tunnel all reported ready or running. Full agent-package typecheck remains unavailable because of the pre-existing missing optional billing SDK package; the affected runtime paths are covered by focused typechecks and tests.
