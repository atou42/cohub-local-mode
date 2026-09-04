# Upstream Rebase Ledger

## Goal

Rebase the local-mode work onto the latest `upstream/main` without losing local capabilities or adding unrelated design work. Publish the rebased history only after explicit authorization.

## 2026-09-04 Rebase In Progress

- Local baseline: `e01787d8f80beba6f3adc5f45b360e2ae156fdd3` (`origin/main`).
- Locked upstream target: `dbf83380d6bb21cbcd46c56ecfafd7b2d5bda384` (`upstream/main`, v2.40.0 changelog).
- Merge base: `fbb16f5dfad8`; divergence at lock time is 49 local-only commits and 16 upstream-only commits.
- Recovery branch: `backup/pre-upstream-rebase-20260904`.
- The rebase runs in a separate worktree. `feat/cloudflare-personal-node-alpha` and its Electron worktree are out of scope and must remain untouched.
- Publication is authorized only after the rebased history passes the required build, focused regression, adversarial, runtime, and browser checks. A failed check blocks push and deployment.

### Rebase Result

- Rebase completed with `dbf83380d6bb21cbcd46c56ecfafd7b2d5bda384` as an ancestor of `main`. All 49 pre-existing local commits map across the rebase; the start-ledger commit and the integration repair commit leave the branch 51 commits ahead of the locked upstream target.
- Conflict resolution retained upstream Generation SDK 0.1.24 while preserving the local CLI dependency, combined upstream atomic upload staging and sandbox capability recovery with the local host workspace mapping, kept the local relay queue UI beside the upstream composer layout, and retained the local TypeScript-compatible Board validation error shape.
- The lockfile was regenerated from the rebased manifests. `pnpm install --frozen-lockfile --offline` passes.
- A clean-worktree `pnpm local:build` failed because SvelteKit-generated metadata in `.svelte-kit` was mistaken for a previously published build. The release gate now recognizes only that exact generated shape, replaces it only after the staged build passes every existing integrity check, and still rejects malformed published builds. The new regression test and the same real build path pass with the repair.
- Upstream's legacy commerce test attempted a real `.test` network request on this machine, and Node 25.3 predates the newer `mock.module({ exports })` API used by the upstream sandbox client test. Both tests now inject deterministic compatibility behavior and pass without weakening their assertions.
- The rebase also restored upstream viewer relationship metadata on locally routed Space search results and resolved the pre-existing harness SVG accessibility lint failures.

### Pre-Release Evidence

- `pnpm lint` passes for all configured workspaces.
- Web type checking passes with 0 errors and 0 warnings after generating SvelteKit types with the Local Mode public environment. Protocol, Identity, Database, Relay, Infra, Model Runtime, SDK, Gateway, CLI, Sandbox Client, and Sandbox Controller type checks pass.
- Full TypeScript checking remains unavailable only where the hosted Billing source imports the unpublished private `@talesofai-billing/sdk@1.16.0`; npm returns 404 for that package. This is the same documented environment limitation as the prior release and does not affect Local Mode runtime coverage.
- 1,453 JavaScript and TypeScript tests pass across Protocol, CLI, Relay, Infra, Web, SDK, Sandbox Client, Gateway, Sandbox Controller, Core, Worker, Agent, and API. Sandbox Go tests pass for every package.
- The final `pnpm local:build` passes after the integration commit. It compiles the Sandbox binary and publishes a complete Cloudflare Web bundle through the atomic release gate while retaining the previous immutable assets.
- A separate Wrangler runtime served the rebased bundle successfully. `/` and `/spaces/release-health` returned HTML with status 200, the application-shell probe passed, Chrome loaded the page with the Cohub title, and every requested client asset returned successfully.
- The failed build directories were preserved until their causes were confirmed, then moved outside the lint scope. The pre-rebase recovery branch remains untouched, and `feat/cloudflare-personal-node-alpha` was not modified.

## 2026-09-01 Rebase

- Local baseline: `bdbd353010995b79344f37a12275701cd9236f29`.
- Upstream target: `ff9689ac1304456a7031f2414def32c8340ecf80`.
- Rebase completed locally with `upstream/main` as an ancestor of `HEAD`.
- All 37 local commits were replayed. Recovery branch: `backup/pre-upstream-rebase-20260901`.
- Upstream process output hardening, dependency upgrades, and sandbox event-order coverage were retained while preserving local harness routing, relay behavior, and process stdin support.
- The regenerated lockfile passes a frozen install. API, Agent, Protocol, and Web suites passed 798 tests in total, all Sandbox Go packages passed, and the production local build completed successfully.
- The untracked `.playwright-cli/` directory was restored unchanged after the rebase.
- No remote history was changed.

## 2026-08-28 Rebase

- Local baseline: `981cb67814a93427af14e2b48ab0e23224cb4866`.
- Upstream target: `0222a34ae4122f46b889a659454f979b730532b4`.
- Rebase completed locally with `upstream/main` as an ancestor of `HEAD`.
- All 20 local commits were replayed. Recovery branch: `backup/pre-upstream-rebase-20260828`.
- The uncommitted Cursor effort work was stashed, restored after the rebase, and remains in the worktree.
- The first rebuilt web bundle exposed two stale merge artifacts in the skill and prompt controllers; both were repaired before publication. The final bundle built successfully and the public browser loaded without runtime exceptions after clearing the old service-worker cache.
- API, Agent, and Web focused suites passed 149, 75, and 388 tests. Local Mode service and Cloudflare Tunnel both report ready.
- Remote recovery branch `backup/pre-rebase-main-20260828` preserves the old `origin/main` at `981cb678`.
- After verification, `main` was updated with `--force-with-lease` to `2e375ebe`. The remote refs were re-read and match the expected hashes.

## 2026-08-26 Baseline

- Local head: `4718799c8927e5ac89810932899e3225ccadf2b2`
- Upstream head: `8f91566aa92bf5fae5cea4cac2557b1c2e8cd947`
- Merge base: `282000a109a7760a5fc7f8ede789248b7ae9498f`
- Divergence: 12 local-only commits and 54 upstream-only commits.
- Recovery branch: `backup/pre-upstream-rebase-20260826`
- Worktree was clean before this ledger was created.

## Required Invariants

- Preserve local Space lifecycle and Mac mini hosting.
- Preserve Codex, Grok Build, and Pi routing, catalogs, parameters, and persisted selections.
- Preserve relay protocol v2, event delivery, queueing, reconnect visibility, and failure exposure.
- Preserve local and cloud cross-Space references, file access, and file transfer behavior.
- Preserve authentication boundaries and current user-visible performance behavior.
- Do not add adjacent features, refactor for taste, redesign, or push remote history.

## Current Status

The 12 local commits have been rebased onto `8f91566aa92bf5fae5cea4cac2557b1c2e8cd947`. Commit mapping is one-to-one and the branch is 12 commits ahead of `upstream/main` with no upstream commits missing. The affected local-mode paths have passed targeted tests, web type checking, relay type checking, production web build, migration consistency, and runtime health probes. Nothing has been pushed.

## Evidence And Decisions

- The pre-rebase local series touches 198 paths. File count is not an acceptance proxy; post-rebase coverage must be checked by commit intent and capability tests.
- Any conflict whose product meaning cannot be established from the local commit, upstream replacement, tests, or ledger evidence must stop the rebase for explicit review rather than choosing one side blindly.
- Upstream occupied migration number 0064, so the local `agent_harness` migration was regenerated as 0065 and the agent turn idempotency index was regenerated as 0066. Both generated snapshots chain from the upstream 0064 snapshot.
- Upstream removed the chat generation task tray. Conflict resolution preserved that upstream removal rather than reintroducing the deleted UI, while retaining local relay routing, Agent selection, model preferences, and cross-Space behavior.
- `git range-diff` maps all 12 old commits to all 12 rebased commits. Differences are migration renumbering, upstream session-title metadata, upstream localization changes, upstream task-tray removal, and the corresponding local adaptations.
- The first frozen install check failed because the merged lockfile retained stale file-based workspace snapshots and missed a Pi peer-dependency variant. Regenerating the lockfile converted the model runtime back to the repository's workspace link and removed the stale duplicate snapshots. A subsequent `pnpm install --frozen-lockfile` passed.
- Web validation initially failed because generated Svelte environment types lacked local public variables. Running Svelte sync with the local public environment produced a clean `svelte-check` result with 0 errors and 0 warnings.
- Full dependency typecheck is limited by the unavailable private `@talesofai-billing/sdk@1.16.0` package on this machine. This is recorded as an environment limitation, not treated as proof that the whole monorepo passes. The affected local relay package and web application were checked independently and passed.
- The normal pre-commit hook invokes that full typecheck and therefore fails on the same missing private package before examining these documentation and lockfile-only changes. The final local bookkeeping commit is created with the hook disabled only after the focused checks below pass; this does not convert the unavailable monorepo check into a pass.

## Final Validation

- `pnpm install --frozen-lockfile`: passed after the lockfile repair.
- `pnpm --filter @cohub/protocol build`: passed.
- Web Svelte check with local public environment: passed with 0 errors and 0 warnings.
- `pnpm --filter @cohub/local-relay typecheck`: passed.
- `pnpm local:build`: passed and produced the Cloudflare web bundle. Existing upstream warnings about an unset optional preview origin and third-party `eval` remain non-fatal.
- `pnpm --filter @cohub/api db:generate`: passed with no schema changes, confirming the 0064 -> 0065 -> 0066 migration chain matches the schema.
- Targeted web tests: 46 passed, including relay state, error exposure, model catalogs, persisted Agent preferences, and cross-Space references.
- Targeted relay tests: 47 passed, including authentication, lifecycle, protocol, event delivery, turn watching, and corrupt-state handling.
- Targeted API tests: 22 passed, including harness catalog, cloud-Space proxying, relay artifacts, local routing, supervisor auth, object presigning, and session harness persistence.
- Targeted Agent tests: 33 passed, including external harness execution, cloud-Space access, Space-aware tools, origin-aware mentions, sandbox status, and intermediate-output normalization.
- Local supervisor tests: 6 passed. Protocol harness schema tests: 2 passed. CLI local-Space test: 1 passed. Sandbox Go tests: passed for all packages.
- Conflict-marker scan: clean.
- `pnpm local:status`: Postgres, Redis, object store, API, Gateway, Web, private ingress, and Cloudflare relay node all reported ready. This is a health probe of the currently running installation, not a deployment of the rebased build.

## Completion Verdict

PASS for the confirmed rebase scope. The latest upstream history is present, all 12 local commits are accounted for, local capabilities retain focused regression coverage, the production web bundle builds, migrations are consistent, and no remote history was changed. The pre-rebase recovery branch remains available at `backup/pre-upstream-rebase-20260826`.
