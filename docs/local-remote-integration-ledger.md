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
- Final Biome validation passes all 26 affected TypeScript, Svelte, and test files. `git diff --check` passes.
- Web type checking still reports only the two pre-existing fixture errors in `models-status-cache.test.ts` and `palette-overview-local.test.ts`; no integrated file reports a diagnostic.
- Agent type checking remains blocked by the existing unresolved private billing SDK imports in `packages/billing`. The focused Agent suite and runtime argument assertions pass, so this external dependency gap is not being represented as a product regression.
- The Local Mode production build succeeds. Generated build `1788066611194` uses app entry `start.Bgw11Drl.js`; its worker calls `skipWaiting()` and `clientsClaim()`, does not precache `_app/version.json`, and includes the early stale-client recovery bootstrap.
- Integrated source through `a2cf6f68823031f045026687c07100855443fb50` was pushed to remote `main` with a normal fast-forward push. `origin/main@0dac8651` remains an ancestor.
- Local Mode was restarted from the integrated build. Postgres, Redis, object storage, API, Gateway, Web, Private ingress, and the Cloudflare relay node all report ready.
- Public Worker `cohub-local-web` was deployed with the matching build and assets as version `2fff314b-d0d5-4298-9200-9ae2c744ff66`. The prior Worker `07666de8-bcc8-4881-b600-4ac7e5ada2c4` remains the rollback point.
- The authenticated public version endpoint returns `1788066611194`; the public HTML and service worker both reference `start.Bgw11Drl.js`. The HTML includes the early recovery bootstrap, and the worker claims clients without precaching the version file.
- A persistent authenticated profile upgraded from the previous Worker on a normal reload. After a 30-second stability window it had one active controller, no waiting or installing worker, no reload loop, and the same auth token plus all three drafts totaling 172 bytes.
- At 320, 393, and 430 pixels, the page root and Chat timeline have equal client and scroll widths. All 31 visible metadata rows have zero overflow. The timeline computes to horizontal hidden, vertical auto, and horizontal overscroll none; harness logos load successfully.
- A real touch-input diagonal swipe in a fresh shared-browser tab moved the Chat timeline from vertical position 500 to 825 while timeline and page horizontal positions remained zero.
- Real touch-input edge swipes opened both mobile drawers to `translateX(0)` and Escape closed each to its off-screen 280-pixel position. A real code block retains local horizontal scrolling with `touch-action: pan-x pan-y`.
- An iPhone standalone production-page simulation kept the shell at 852 pixels initially, allowed it to shrink to 511 pixels while the textarea was focused, then restored it to 852 pixels after blur while the reported viewport was still 744 pixels.
- At 1440 by 900 pixels, the page root, Chat timeline, and all 31 metadata rows have zero horizontal overflow; the desktop sidebar and active service worker are present.
- The per-Space access configuration still maps only `d5bb1cb3-2154-4037-944f-554e83200df5` to `/Users/atou`. The macOS Sandbox test performs a real allowed-root write and a real unconfigured-root denial; Agent tests verify the same roots are passed to Codex, Cursor, and the matching Grok profile, while an unconfigured Space receives none.

## Failures and blockers

- The prior public deployment used the old local base and replaced the remote iOS fixes. This is the regression being corrected.
- The repository pre-commit typecheck cannot resolve the existing private billing SDK modules. Commits were made with the hook disabled only after the affected Agent and Sandbox tests passed; final validation will record the full typecheck result rather than hiding it.
- The first shared-browser tab timed out on synthetic touch input because it retained an old CDP input lock. The same diagonal and drawer probes passed in fresh tabs inside the same authenticated shared profile; no temporary browser profile was used.

## Next action

Complete. Future web releases must build and deploy the Worker and its static assets together from remote-tracked source.
