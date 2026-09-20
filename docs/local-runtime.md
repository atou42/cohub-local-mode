# Local Runtime

## Execution

A Space has one local Runtime connection. Users select a Harness, not a machine.

```bash
cohub auth login
cd ./project
cohub runtime up --harness pi --harness codex
cohub runtime up --harness codex # reuses the same Space
cohub spaces prompt "Continue" --harness codex
cohub runtime status

# To bind this directory to another local Runtime explicitly:
cohub runtime up --space <space-id> --harness codex
```

`runtime up` replaces `sandbox up`. When `--space` is omitted, the CLI remembers
the Space for the canonical directory, account, and environment in
`~/.config/cohub/runtime-spaces.json`. The first start creates and records a local
Space; later starts reuse it. An explicit `--space` or `COHUB_SPACE_ID` overrides
and updates the directory binding.

It supervises the workspace bridge and the Harness connection. Node.js 24+ is required.
Pi and Codex must already be installed and authenticated locally. `--pi` and `--codex`
override executable paths. Repeated `--harness` options and comma-separated values are
accepted. `--yes` accepts the explicit local execution consent for non-interactive startup.

## Diagnostics

The Runtime writes redacted, ordered JSONL diagnostics under
`~/.local/state/cohub/runtime/<space-id>/diagnostics/`. Network, WebSocket,
Harness, archive and sandboxd lifecycle failures include `runtimeId`,
`connectionId`, `requestId`, `sessionId` / `turnId`, and when available the
server `traceparent` / `traceId`.

```bash
cohub runtime logs --space <space-id>
cohub runtime logs --space <space-id> --follow
cohub runtime logs --space <space-id> --json
```

Diagnostics stay on the local machine and are never uploaded automatically. Use
`runtime logs` or `runtime logs --json` to inspect or export them. Prompts, tool
arguments, file contents and credentials are not recorded.

## Shared Pipeline

```text
API prompt -> BullMQ -> Session lock -> Harness dispatch
                                      |-- Cohub runtime
                                      `-- Gateway WS -> local Pi RPC / Codex app-server

Harness events -> Agent sendOutput -> existing snapshot / patch -> Web / SDK
Harness messages -> existing persistence / finalize -> DB / realtime
Local native session -> durable segments -> CLI presigned PUT -> object storage
Archive metadata -> API confirmation -> turn.harnessIndex
Object storage -> CLI presigned GET -> verified native restore
Cloud native session <- DB context (no harness archive)
```

There are no HTTP polling/claim/result endpoints. The outbound local connection
uses `/runtime/relay`; internal Agent peers use `/internal/runtime-relay/:spaceId`.
The existing workspace relay remains responsible for files and processes.

The same Session lock and queue serialize Cloud and Local execution. At claim time,
all runnable queued follow-ups form one ordered batch, regardless of author or requested Harness.
The final turn owns execution: its Harness, model, thinking and supported configuration are selected.
Execution uses the owner's authorization; author permissions are never combined. A read-only request
anywhere in the batch makes the entire batch read-only (Pi rejects this before dispatch).

Each source turn/message and its author, requested Harness and original content remain intact.
Earlier turns point to the owner through `mergedIntoTurnId`. Local adapters receive the batch content verbatim:
no prefixes, ordinals, separators, explanations or internal user/turn/message IDs are added to prompt text.
Representable blocks and tool pairing are preserved; URL images, system notes and unknown blocks are dropped from
the model input, never described in text, and their durable copy stays in the platform. Only the existing system
prompt builder may author platform instructions. Streaming, results, usage and native archive references
belong to the owner. Local tools still run as the Runtime host's OS user; local usage is not charged as a Cloud turn.

Steer/direct shell commands remain single-turn; direct-generation barriers remain unchanged.
New follow-ups arriving after a claim wait for the next batch. An unavailable owner Harness fails explicitly,
never silently switches executor. Recovery reconstructs the persisted claim and only re-delivers saved results;
it does not collect new queued inputs or replay models/tools.

## Resume

- The first head response includes a ready archive reference when available, avoiding an extra cold-resume round trip.
- A missing or outdated projection requests history over the same WS connection.
- Same-Harness native files are validated and reused. A matching archive can
  restore a missing native file. Pi handoff writes durable messages into its native session file, while
  Codex handoff has no native history channel yet and starts without history (durable history stays in the platform).
- Codex paginated threads depend on a private SQLite index. Archive import creates
  a separate legacy-history projection and uses native `thread/fork(path)`;
  the original archive and thread are preserved. The private database is never uploaded.
- Cloud uses the same history reader, including fork segments and compaction
  boundaries. History reconstruction never executes old tools.

Local bookkeeping is under `~/.local/state/cohub/runtime/<space-id>`; native
credentials and configuration remain in the original Harness locations. Existing
files are not overwritten when they contain unconfirmed or externally modified
history. Native segments reuse the existing turn storage bucket and signing path, without setting object ACLs.
Access control follows the bucket policy; only short-lived, authorized PUT/GET URLs are issued by the API.
API, Gateway and Agent never proxy archive bytes.

## Runtime Recovery

Recovery is event-driven and Session-scoped. The local Runtime streams every pending
`sessionId` / `turnId` identity in bounded batches after it connects; Gateway peer disconnects and Agent
transport uncertainty also enqueue reconciliation for that Session. Recovery takes the
Session lock, validates the active owner and reconstructs its persisted batch before
reading a saved result. There is no periodic database scan. `turn.recover` is internal
and reads saved results only, without starting Harnesses or replaying tools. Recovery
does not depend on the original WebSocket request ID.

```bash
cohub runtime status --space <space-id>
```

There is no public recovery command. Space headers show connection status; an affected
Chat exposes explicit stop confirmation only when its active local execution is uncertain,
requiring `sandbox.manage`. Confirmation is bound to that Session, active turn and recovery
revision; newer executions are never included. Original turn input, committed
messages, native files and result receipts are retained. A durable resolution note
records that prior effects remain unknown; late results cannot replace this terminal
state. Local projections are retired before rebuilding from server context. If an ACK
was lost before switching Harnesses, the Runtime asks only about its current pending
projection and rebuilds from the latest durable context when switching back.

An orphaned local projection never blocks a Harness permanently: once the server
reports that turn as terminal, the projection is archived under `retired/` and rebuilt,
whether or not a local result receipt survived. Only turns the server still considers
active require explicit local confirmation. Native files are never deleted.

Transport uncertainty is surfaced immediately on the active Session. Reconnect and
bounded queue retries can still recover a saved result; an explicit missing-result response
keeps the Session in attention until Runtime reconnects or a manager confirms it stopped.
Never infer that a disconnected execution has stopped.

## Boundaries

- Adapters currently start an RPC process per turn. Native conversation history
  resumes, but in-process PTY handles, background terminals and interactive
  extension state are not guaranteed to survive between turns. This is not full
  interactive-native parity; persistent Harness processes require a separate lifecycle design.
- Use Pi versions exposing RPC session events and Codex versions supporting
  app-server thread resume/fork. Verified with Pi 0.85.1 and Codex 0.154.0.
  Codex rollout-path recovery is an upstream experimental API; incompatible versions fail explicitly.
- Native approval escalation is never automatically granted. Requests requiring
  an interactive local approval are rejected by the unattended adapter. Pi
  read-only execution is rejected because it cannot enforce the requested limit.
- Unknown execution outcomes remain active and block automatic takeover. Local
  unconfirmed state requires reconciliation; it is not silently discarded or replayed.
- Completed results are durably checkpointed locally before delivery. A lost
  acknowledgement can replay that result, never the model or its tools. Only the
  latest result per Session/Harness is retained, avoiding an unbounded local outbox.
- Cloud turns do not write `harnessIndex` or upload native files. Missing Cloud files
  rebuild from DB messages and compaction boundaries; cached handles use lightweight revisions.
- Local turns capture immutable raw-byte segments (up to 4 MiB each) into a durable outbox.
  A verified unchanged prefix extends the prior version; truncation or any prefix rewrite starts
  a new baseline. Each turn stores only its parent reference and new segments, not the whole list.
- Uploads retry every 10 seconds while Runtime is running, including after restart with no new turn.
  Model-result ACK and archive confirmation are independent. `runtime status` reports `pendingLocalArchives`;
  Web shows pending/ready/unavailable archive state. Failed capture is retried before another turn can mutate the file.
- Missing/changed native files and malformed capture receipts are quarantined under `archives/failed/captures/`.
  The exact receipt and failure reason are retained; native files stay untouched. These failures stop retrying and
  are reported by `runtime status.failedLocalArchives`. Transient I/O errors keep retrying.
- Confirmation validates authorization, parent identity, contiguous offsets, object lengths and storage-verified MD5.
  Restoration verifies every SHA-256 and every version digest before atomically publishing a new file.
  Only ready, valid indexes are offered for native recovery. Pending, failed or invalid indexes use DB history.
  If download or import fails, CLI logs a warning and requests DB history once before starting a new Harness projection;
  this is reported as a handoff, never a successful native restore. Cancellation and unconfirmed local execution still block continuation.
- One claim is bounded by message count and estimated input bytes, and the protocol enforces the same
  message cap. A larger queue splits into consecutive batches instead of failing after turns were merged.
- Metadata requests are bounded to 256 new segments per version (at most 1 GiB of newly captured bytes).
  Limits fail explicitly and preserve original files. No object GC or lifecycle changes are made by the code.
  Lifecycle policies must retain old segments for as long as any supported recovery version references them.
- Final local messages and terminal Turn state commit atomically. Realtime,
  postprocessing and bound external channels are best effort; durable Session data remains
  authoritative and reloadable when a notification fails.

## Verification

```bash
pnpm --filter @cohub/protocol test
pnpm --filter @cohub/agent test
pnpm --filter @cohub/agent test:runtime
pnpm --filter @neta-art/cohub-cli test
pnpm --filter @neta-art/cohub-cli test:runtime
RUNTIME_TEST_DB_HOME=/path/to/isolated-db pnpm --filter @cohub/api test:runtime:archives
```

`test:runtime` uses loopback WebSockets and fixture RPC processes, never real
accounts or model requests. The optional `test:runtime:db` uses an isolated PostgreSQL
engine and requires `RUNTIME_TEST_DB_HOME`; it never connects to production. Apply `0065_runtime_harness_index` before deploying
services that read `harness_index`. Native object prefixes must remain private, including through any CDN origin authorization;
verify signed PUT/GET, create-only writes and single-PUT MD5/ETag behavior against the configured storage before release.
No production-bucket writes are performed by the automated tests.
Deploy Worker, API, Gateway and every Agent instance
before enabling the updated Web/CLI. Worker must understand local usage before local
results arrive, so they cannot be charged as cloud executions.

For opt-in real-model testing, prepare an isolated directory containing `home/`,
`pi/` and `codex/`, with native authentication/configuration. This test makes model
requests and writes temporary files; archive storage is injected in-memory and it never connects to a Cohub server. Set
`COHUB_NATIVE_TEST_PI_BIN` / `COHUB_NATIVE_TEST_CODEX_BIN` to override executables.

```bash
COHUB_NATIVE_TEST_HOME=/path/to/isolated-config \
COHUB_NATIVE_TEST_PROVIDER=your-provider \
COHUB_NATIVE_TEST_MODEL=your-model \
pnpm --filter @neta-art/cohub-cli test:runtime:native
```

The native matrix checks streaming, real file-writing tools, native resume,
archive import, Pi/Codex handoff and abort with partial-output retention. Provider
features and sandbox permissions come from the test configuration, not Cohub overrides.
