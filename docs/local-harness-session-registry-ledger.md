# Local Harness Session Registry Goal Ledger

## Goal

Provide every Local Mode Space with a local-only session registry under `.cohub/local-sessions/`. Keep Pi, Codex, Grok Build, and Cursor Agent native storage unchanged while exposing durable Cohub-to-native mappings and a normalized read-only transcript that every harness can discover from the Space workspace.

## Scope Boundaries

- Change only this Local Mode fork and files generated inside local Space workspaces.
- Do not change cloud behavior, upstream storage contracts, or native harness storage formats.
- Keep generated session data out of Git.
- Preserve agent startup, native resume, model and effort selection, relay delivery, identity, and file access behavior.

## Current Facts

- Pi session JSONL is stored under `SESSIONS_DIR/spaces/<space-id>/<session-id>.jsonl`.
- Codex stores rollout JSONL under `~/.codex/sessions/...` using its native thread ID.
- Grok Build stores a native session directory under `~/.grok/sessions/<encoded-cwd>/<native-session-id>`.
- Cursor Agent stores ACP state under `~/.cursor/acp-sessions/<native-session-id>` and does not use JSONL as its primary format.
- `space_sessions.external_session_id` already records the active external harness ID, and external assistant message metadata retains harness and external session IDs.
- The existing Local Mode workspace does not contain a stable cross-harness mapping or normalized transcript.

## Decisions

- Native artifacts remain authoritative for harness resume and are never rewritten by the registry.
- Cohub DB messages are authoritative for the shared normalized transcript.
- A manifest retains every observed native harness mapping, including historical mappings recovered from message metadata and legacy Pi files.
- Missing native artifacts are represented explicitly instead of being hidden by a fallback.
- Registry files use atomic replacement and reject malformed existing manifests rather than overwriting evidence.

## Progress

- 2026-09-01: Confirmed the storage layout and the missing cross-harness discovery layer. Implementation started.
- 2026-09-01: Added the Local Mode registry, atomic normalized transcript projection, native artifact discovery, historical harness mapping recovery, Git exclusion, startup backfill, per-turn sync, and explicit sync-error records.
- 2026-09-01: Exposed stable registry, manifest, and transcript paths to Codex, Grok Build, and Cursor through `COHUB_*` environment variables and prompt context; exposed the same workspace path to Pi through its Local Mode system prompt.
- 2026-09-01: Extended the macOS service bootstrap retry window after a real graceful restart showed launchd could retain the previous service coalition longer than five seconds.
- 2026-09-01: Deployed the source-backed Local Mode service and completed a real Codex-to-Grok transcript read.

## Validation Evidence

- Focused registry, harness-context, and system-prompt suite passed 39 tests.
- Full `@cohub/agent` suite passed 98 tests.
- Biome passed for all affected source and test files; `git diff --check` passed.
- `pnpm local:build` completed successfully, including the local sandbox binary and production web build.
- Startup backfill completed after restart for 4 local Spaces and 113 Sessions. The main Space index contains 87 Sessions with no `sync-error.json` records.
- Real mappings resolved available native artifacts for Pi, Codex, Grok Build, and Cursor. The main Space currently has 25 Pi, 32 Codex, 15 Grok Build, and 13 Cursor available mappings; two genuinely absent native artifacts remain explicitly marked `missing`.
- A new Cohub Codex Session `045d945d-9507-4ab8-ab7d-5458ad858847` read the normalized transcript of Grok Build Session `d0036a4c-1a03-4344-b473-bb4d5a672acd` and returned exactly `CROSS_HARNESS_OK:GROK_TARGET_OK`.
- The new Codex Session automatically produced its manifest and transcript, resolved native rollout `01a05d53-e007-7563-97f2-848998626be8`, and recorded no sync error.
- Forked Cursor Session `1ce1a6be-4344-4ed4-b298-c79b567ed0f2` projected the parent segment through sequence 2 and then its own segment; the first three parent message IDs matched the database exactly.
- Hashes of representative Pi, Codex, Grok Build, and Cursor native artifacts were unchanged across registry synchronization.
- Shared transcripts retain useful harness identity and status metadata while excluding prompt environment, authorization context, user identity fields, and raw vendor runtime payloads; the live registry contains zero unsafe top-level metadata keys and zero `runtimeEvent.raw` objects.
- Malformed manifests were preserved and rejected, missing artifacts were exposed, path traversal IDs were rejected, historical mappings survived harness changes, and eight concurrent identical projections produced valid stable files.
- A second real `local:service:restart` waited through launchd error 5, recovered automatically, completed startup backfill, and returned every Local Mode health check to ready.

## Blockers

None. The repository-wide agent typecheck still reports the pre-existing unavailable optional private billing SDK; the affected Local Mode code was covered by runtime compilation, the focused suite, the complete agent test suite, and the successful deployed flow.

## Next Action

Commit the verified Local Mode changes when requested.
