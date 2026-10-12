# WorkBuddy Local validation — 2026-10-12

## Verified

- WorkBuddy 5.1.3 / bundled CodeBuddy CLI 2.103.3 initializes with the WorkBuddy product environment and returns its native model catalog without sending a model prompt.
- A synthetic projected history containing a system message, user text/image, reasoning, a tool call/result and an assistant response is accepted and replayed by the installed CLI. The current stream translator accepts that real replay, and the original file remains byte-identical. No user history was uploaded.
- 54 CLI tests pass across WorkBuddy execution, process protocol, translation, transcripts, archive restoration, ownership, ingestion, discovery and existing runtime lifecycle behavior. They cover explicit errors, cancellation, interrupted recovery, immutable sources, prefix validation, branch preservation, stale-history rejection and deduplication.
- Protocol: 189 tests. SDK runtime: 2. Core prompt model validation: 3. Background queue: 4. Web model selection/status: 14. All pass.
- 33 existing native transcript, translation, archive, installation and projection tests pass alongside the new implementation.
- 16 existing execution, recovery and batching tests pass using `TMPDIR=/private/tmp`. On macOS, `/tmp` aliases `/private/tmp`; older Pi fixtures hash those differently and time out. The same failure/pass pair was reproduced at base commit `4d30d49`, without product changes.
- All 10 existing native-ingestion tests also pass with `TMPDIR=/private/tmp`, including the previously timed-out Codex file watcher.
- CLI production build and full web typecheck pass; the latter reports zero errors and warnings.
- Protocol, SDK and infrastructure typechecks pass. Lint passes on all 62 changed code/test files without warnings.

## Remaining acceptance

- No authenticated model turn, paid generation, live Cohub sync, real-account continuation/cancellation, deployment or cross-device acceptance was performed.
- A system message is accepted by native resume but not replayed. Its effect on actual model context is not established without a model turn.
- Desktop and mobile visual inspection was blocked by browser tool connection-policy errors. Component syntax and complete web typechecking pass.
- Automatic app discovery was verified on macOS only. Explicit executable paths are supported elsewhere but not validated on another operating system.
- Broader server typechecks cannot complete in this checkout: the private billing SDK and several server dependencies/build exports are unavailable, with duplicate dependency types also affecting the agent. These checks must run in a fully provisioned CI environment.
- The repository pins pnpm 12.10.1; the installed launcher cannot execute that managed binary. Checks above ran directly through the existing local tools. No dependency or package-manager configuration was changed.

WorkBuddy desktop-held conversations are intentionally not controlled concurrently. Cohub continues in private native copies, retains the same cloud conversation, and does not promise automatic listing of those copies in the WorkBuddy desktop UI.
