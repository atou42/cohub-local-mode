# Cloudflare Relay Goal Ledger

## Goal contract

Replace the synchronous browser-to-Mac Local Mode path with a production Cloudflare control plane. The browser and the Mac node connect outward to Cloudflare. Messages are durably accepted before Mac execution, retain ordered lifecycle state, survive node restarts and offline periods, and execute once at the Cohub API boundary. Explicit client uploads and explicitly returned artifacts use a private R2 relay. Local Space workspace files, context, credentials, indexes, and session runtime remain on the Mac. The existing Cohub UI, hosted Cloud Spaces, Pi, Codex, Grok Build, harness-specific model and effort catalogs, and immutable harness choice after a Session starts remain intact. The existing Tunnel remains an explicit rollback route and does not mask relay failures.

## Final status

`VERDICT: PASS` on 2026-08-25.

The public client is live at `https://cohub.atou.cc`. The Cloudflare control plane is live, the Mac node is connected outbound, offline enqueue and restart recovery are proven, private file relay works in both directions, and all services were restored to ready state after the final offline probe.

## Delivered architecture

`cohub-local-relay` is a dedicated Cloudflare Worker. One Durable Object per local node owns the ordered command ledger, leases, lifecycle state, result cache, browser status stream, and node WebSocket. The Queue carries wakeups only; the Durable Object remains authoritative. The Mac relay node authenticates outbound, claims work, maintains leases, calls only allowlisted loopback prompt routes, and reports terminal results. Stable command and client message identities provide cloud idempotency and local API deduplication.

The deployed web shell serves Cohub routes from Cloudflare while `/api`, `/ws`, and `/cohub-assets` remain available through the existing private ingress. Local prompt writes use the relay. Cloud Spaces continue to use hosted Cohub. Cached Local Session state renders without waiting for the Mac, and node-only surfaces show `Local Mac is offline` instead of leaking an upstream HTML failure.

The private R2 bucket stores only browser-selected input files and files explicitly linked by an assistant response. Input files are verified before command attachment and materialized under the target Space's `.cohub/relay-attachments` directory. Returned files are accepted only when a Markdown link resolves to a regular file inside that Space workspace. The node uploads the exact bytes, persists the private relay URL into the completed local turn, and never uploads unrelated workspace contents.

## Deployed resources

| Resource | Live value |
| --- | --- |
| Owner route | `cohub.atou.cc/relay/*` behind Cloudflare Access |
| Node route | `relay-node.atou.cc` with independent node bearer authentication |
| Relay Worker | `cohub-local-relay`, version `252675a5-a9e6-4de5-92e7-ec1911b552fc` |
| Web Worker | `cohub-local-web`, version `a8f7359d-95f1-4029-9d5f-7ac82c43163c` |
| Queue | `cohub-local-relay-wakeups` |
| R2 bucket | `cohub-local-relay-attachments`, private |
| Durable Object | `LocalNodeRelay`, one instance per local node |
| Mac service | LaunchAgent `cc.atou.cohub-local-mode` |

Node and owner credentials are stored outside the repository. No credential value is recorded in this ledger.

## Performance evidence

Twenty unique authenticated public command creates returned HTTP 202 with 102 ms minimum, 140.9 ms p95, and 258.1 ms maximum. Twenty repeats of the same idempotency request all returned the same command identity with 110.5 ms p95. A real UI enqueue while the Mac was offline acknowledged in 168.4 ms. Observed claim-to-running transitions were 85 ms and 432 ms in the measured recovery and probe paths, below the one-second acceptance boundary.

## Reliability evidence

The Mac service was stopped before submitting command `7e85583c-bd3b-4b74-946f-013d5b57fe1b`. The browser received the cloud acknowledgement, retained its optimistic message through a full page reload, and showed an explicit offline notice. After the LaunchAgent restarted, the node kept the claim alive while the local API started, then completed with the exact response `OFFLINE_RECOVERY_OK_20260825_B`. The pending browser record cleared only after a validated terminal result. The local database contained exactly one completed turn for client message `10ac8d56-7b37-42e4-861a-3e87f5bcd5b5`.

The original restart race was captured as `local_api_unavailable` for command `6a507176-9b89-4669-a714-566658231532`. The node now retries only transient local startup and transfer failures while maintaining the command lease. Abandoning the connection aborts the active attempt so the Durable Object can recover it after lease expiry. Durable Object tests cover ordered sequences, duplicate creates, stale attempts, reconnects, and terminal replay.

## Attachment evidence

An authenticated browser upload was stored in R2, downloaded by the node, checksum-verified, materialized inside the target Space, and read by the real Codex harness with exact bytes. Corrupt upload completion returned HTTP 422. Undeclared attachment IDs, path traversal, size violations, checksum mismatches, missing node credentials, and attachment identity mismatches are rejected.

A real UI turn, command `bd17b57f-2b65-4728-a635-fb6a75e77e19`, returned `[download](original-space-recovery.txt)`. The node uploaded only that linked file and persisted `/relay/v1/nodes/mac-mini/attachments/8f02a053-7af5-4697-8094-491df8e3e9dd/content` into turn `476d6af7-b293-4261-849c-c9027cc4e00a`. The link remained correct after a browser reload. Its public owner-authorized response was 30 bytes with SHA-256 `68356817247e4f42e98d50da1fbd36222e27a790a0640aad95e75406444053bb`, exactly matching the local source. It continued returning the same bytes while the entire Mac service was stopped, proving the download is served from R2 rather than the workspace.

## Security evidence

The owner route without Cloudflare Access returned 401. A valid Access session with an unapproved Origin returned 403. The node route returned 401 with no token and 403 with a wrong token. An allowlisted-owner browser cannot call the loopback-only artifact projection endpoint through the public route; the live response was 403 `loopback access is required`. Invalid local API paths return 403. Expired attachment state returns 410, malformed state returns 500, and owner and node downloads remain separately authorized.

The Worker validates node identity, command path, body limits, origin, attachment operation, object identity, size, content type, and SHA-256. The node rejects filesystem escapes, symlinks, non-files, oversized returned files, undeclared attachment references, and returned links outside the active Space workspace. Core errors remain visible and are not converted into successful empty responses.

## Product evidence

The left navigation preserves Cloud Spaces and a distinct Local Mac mini area. Pi, Codex, and Grok Build expose their own model and effort catalogs. A Session's harness locks after its first submitted turn. Local Session creation is client-identified and idempotent, so a new Session can be queued while the Mac is offline without producing a missing sandbox endpoint failure.

Desktop and mobile browser checks loaded the real production page, rendered cached history, preserved the composer layout, and displayed the offline state without `Load failed`, raw Cloudflare HTML, overlap caused by the new notice, or a blank shell. The Files pane retains its last confirmed tree while clearly indicating that the Mac is offline.

## Automated checks

| Check | Result |
| --- | --- |
| Relay Worker protocol, authorization, lifecycle, attachment, expiry, and corruption tests | 11 passed |
| Mac relay node auth, retry, lease abort, input attachment, returned artifact, and terminal polling tests | 12 passed |
| Local artifact projection and loopback boundary tests | 5 passed |
| Web local-offline error normalization tests | 2 passed |
| Web TypeScript and Svelte validation | 0 errors and 0 warnings |
| Production Local Mode web build | Passed; only pre-existing bundler warnings remain |
| API focused suite | 207 passed in the final API regression run before the artifact projection addition; the new projection has focused unit and live integration coverage |
| API typecheck | No error in changed relay code; repository-wide check remains blocked by the pre-existing missing optional `@talesofai-billing/sdk` dependency |
| Working tree whitespace validation | Passed |

## Operations and rollback

`pnpm local:status` reported Postgres, Redis, object store, API, Gateway, Web, private ingress, and Cloudflare relay node ready after the final Mac-offline R2 test. `pnpm local:tunnel:status` reported the existing Tunnel service and connector running. Rollback requires removing the Cloudflare web and relay route bindings so `cohub.atou.cc` returns to the already-running Tunnel path; no Local Space data migration or R2 dependency is required to restore the previous transport.

Five orphaned worker groups from older Local Mode service runs were removed after confirming they were outside the current LaunchAgent process group. The current runner starts each child in its own process group and stops the group on service shutdown. This removed the persistent CPU contention that had been making unrelated client operations feel slow.

## Protocol v2: event plane and delivery-only commands (2026-08-26)

Landed in commit `213f55a8` (18 files, +3179/-272). Both sides upgrade in lockstep; there is no v1 compatibility mode.

Relay commands now complete when the local API accepts the prompt instead of waiting for the terminal turn state, which removes the node-wide serial bottleneck on long turns. A node-side turn watcher polls the local turn until terminal, uploads returned artifacts, and emits `turn-event` messages that the Durable Object stores, deduplicates, and broadcasts to browsers as `turn.event`. Browsers connect to a WebSocket event plane and receive a `snapshot` (all non-terminal commands, the newest 20 terminal commands, the newest 50 turn events) followed by `command.updated` and `turn.event` pushes; HTTP polling remains only as a 2-second fallback when the socket is unavailable. Queued commands can be cancelled through `POST /commands/:id/cancel` and a Withdraw affordance in the composer; active leases return 409.

The Durable Object gains garbage collection (terminal commands capped at 200 and 7 days, turn events at 200, expired attachments removed from R2), a 5-attempt retry cap with `max_attempts_exceeded`, UTF-8 byte-accurate result truncation at 768KB, and a 60-second lease. The node no longer aborts in-flight work when the WebSocket drops: results queue in memory and resend on reconnect, and the Durable Object accepts a finished result for a requeued command with a matching attempt instead of stranding it, acknowledges duplicate or post-cancellation outcomes idempotently, and redispatches after a stale attempt. The turn watcher survives transient local API failures and corrupt persisted state instead of crashing the node process.

Verification on the landed tree: relay Worker tests 23 passed, relay typecheck and Biome lint clean, node tests 24 passed, web tests show only the three pre-existing baseline failures with 12 new tests passing, and web typecheck shows only the pre-existing `$env` environment errors.

Remaining rollout steps at the time of this entry: deploy the relay Worker (`pnpm --filter @cohub/local-relay deploy`), restart the LaunchAgent (`launchctl kickstart -k gui/$UID/cc.atou.cohub-local-mode`) so the node reconnects with protocol 2, then run the live end-to-end pass (three harnesses, offline enqueue, reload recovery, cancel). Until the Worker deploy and service restart happen together, the running system stays entirely on v1; a node restart before the Worker deploy would leave the node in a protocol-mismatch reconnect loop.

## Protocol v2 rollout and live acceptance (2026-08-26)

The relay Worker was deployed (version `66374419`, `COMMAND_LEASE_MS=60000`) and the LaunchAgent restarted; the node reconnected with `protocolVersion: 2`. The first live acceptance pass returned 4 PASS / 1 FAIL: three-harness turns, refresh recovery, and idempotent offline recovery all passed, but the Withdraw affordance was missing for queued commands. Root cause: the `cohub-local-web` Worker still served the pre-v2 client bundle — deploying only the relay Worker leaves browsers on the old client, so the passing items were riding on the legacy polling and gateway-stream paths rather than the new event plane. Lesson for future rollouts: a v2 change to the web client requires `pnpm local:build` followed by `pnpm --filter web exec wrangler deploy --config wrangler.local-mode.toml` in the same rollout as the relay deploy.

After the web Worker deploy (version `ab92fbbc`), a second acceptance pass returned all PASS. Offline queueing shows the "Waiting in queue" row with a working Withdraw button; withdrawing removes the optimistic message cleanly, and host logs confirm the withdrawn command never executed while a control message queued in the same outage executed exactly once after recovery. A `wrangler tail` capture during the pass confirmed the event plane end to end: the browser's `/events` WebSocket upgrade reached the Durable Object, and the entire offline-queue window produced zero `GET /commands/:id` polls — cancel confirmation and recovery completion were delivered over the socket. The cancel endpoint returned OK on the Withdraw click.

Known follow-ups observed during acceptance, none blocking: the browser still polls `GET /nodes/:id/status` every 3 seconds for the offline banner (candidate for migration onto the event plane); `relay-node-status.json` retains a stale `connected` state after the process dies (freshness must be judged by `updatedAt` or the PID); withdrawing the only message of a new Session deletes the Session server-side, so the sidebar shows a cached entry that resolves to "Not found" until refresh; the offline model selector degrades to a placeholder label; cold service startup takes roughly 34 seconds with transient `local_api_unavailable` retries.
