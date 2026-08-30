# Local and remote integration ledger

## Goal

Integrate `origin/main@0dac8651` with every intentional Local Mode worktree capability, then publish one matched local-service and public-web release without losing the remote iOS fixes, local host access, compact chat controls, or PWA stale-client recovery.

## Baseline

- Local branch before integration: `6a9ae34dba51f08183d9ac65b36981109c218587`.
- Remote baseline: `0dac8651c04e8235f6e339675f0cae95a92310b9`, six commits ahead.
- Local committed history had no commits absent from the remote. All local-leading work was uncommitted.
- Recoverable snapshot: `/Users/atou/.cohub-local-mode/recovery/20260830-130446-local-remote-integration`.
- Public Worker before integration: `07666de8-bcc8-4881-b600-4ac7e5ada2c4`.

## Required remote capabilities

- iOS standalone keyboard viewport recovery.
- Chat timeline horizontal scroll and overscroll containment without disabling drawer gestures or local table and code scrolling.
- Bounded mobile message metadata with model/effort and usage/duration grouping.
- Official harness logos and compact effort labels.

## Required local capabilities

- Per-Space host writable roots for Pi, Codex, Cursor, and Grok, including fail-closed path validation and runtime isolation.
- Codex app-server startup failure cleanup.
- Persistent Fork affordance with an unavailable-checkpoint explanation.
- Dense composer metadata, compact elapsed time, and bounded process summaries.
- Immediate PWA worker takeover, one bounded reload, stale-import marker cleanup, and preserved browser state.

## Conflict decisions

- `ChatMessageBubble.svelte` keeps the remote full-width overflow boundary, two metadata groups, compact cached-token text, and shared copy/Fork button class. It also keeps the local always-visible terminal Fork affordance, unavailable-checkpoint explanation, and compact mobile model rendering.
- `SessionComposer.svelte` keeps the remote harness-logo implementation. The local compact model/effort/speed trigger remains in `ComposerModelTrigger.svelte`.
- `+layout.svelte` keeps the remote iOS standalone viewport action and app-shell height contract, while adding the local stale-import marker cleanup and removing the obsolete conservative service-worker registration.
- Remote horizontal containment in `ChatTimeline.svelte`, iOS viewport recovery, official logos, and compact effort mapping remain unchanged.
- Local per-Space host access, compact elapsed time, bounded process summaries, and PWA takeover remain separate changes on top of the remote baseline.

## Validation evidence

- Recovery snapshot checksums were written before any Git operation.
- Rebase completed with `origin/main@0dac8651` as an ancestor and three local capability commits on top.
- Focused Agent harness tests pass 31 tests with the Local Mode environment. Their existing Redis initialization attempts are rejected by the unit-test network guard and do not fail the suite.
- Focused Sandbox `env` and `rpc` Go packages pass.
- The first integrated Web run failed one source-structure assertion because the remote test still searched for the replaced `canFork` branch. The test was repaired to assert the new `forkState.visible` path, shared button class, click handler, disabled state, and visible presentation.
- The repaired full Web suite passes 419 tests.
- Biome found one formatting difference introduced during conflict resolution; it was formatted and the targeted check then passed.

## Failures and blockers

- The prior public deployment used the old local base and replaced the remote iOS fixes. This is the regression being corrected.
- The repository pre-commit typecheck cannot resolve the existing private billing SDK modules. Commits were made with the hook disabled only after the affected Agent and Sandbox tests passed; final validation will record the full typecheck result rather than hiding it.

## Next action

Run final type, build, and generated-artifact checks, then commit this integration record and publish the matched release.
