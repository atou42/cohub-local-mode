# Upstream Rebase Ledger — 2026-09-03

## Goal

Rebase the stable local `main` series onto the latest fetched `upstream/main`, retain upstream capabilities and all confirmed Local Mode behavior, then publish and deploy the verified result. Keep `feat/cloudflare-personal-node-alpha` independent from this mainline rebase.

## Locked Baseline

- Pre-rebase local `main`: `c46f4a99103d2659a44b47852b5eabb8fc12771c`.
- Upstream target: `bcd9e6b092164ab27cc559731bbb477dd90f1f82` (`v2.38.1`).
- Merge base: `ff9689ac1304456a7031f2414def32c8340ecf80`.
- Divergence: 41 local-only commits and 34 upstream-only commits.
- Local recovery branch: `backup/pre-upstream-rebase-20260903`.
- Independent alpha branch: `feat/cloudflare-personal-node-alpha` at `bb50e0591ee926a9850535508b80c37b0970b737`.
- The worktree was clean before the rebase.

## Required Invariants

- Retain upstream App Center, Marketplace, Board geometry, Board CLI/SDK, cron consistency, and release changes through `v2.38.1`.
- Preserve Local Space hosting, Pi, Codex, Grok Build, and Cursor routing, model and effort catalogs, persisted preferences, and visible intermediate output.
- Preserve bidirectional Local/Cloud Space reads and mutations, execution identity, relay protocol, file transfer, Local session registry, and explicit failure behavior.
- Preserve desktop and mobile layouts, stale-client recovery, app-shell cache policy, atomic release gates, and service health checks.
- Do not include the Personal Node Alpha feature commit, redesign unrelated surfaces, change hosted Cohub, or discard a local behavior merely to make the rebase pass.

## Initial Risk Assessment

- Upstream changes 117 paths; seven paths overlap the stable local series.
- A three-way merge simulation completed without textual conflicts, but the sequential rebase remains authoritative because earlier local commits may require semantic adaptation.
- Package versions move from CLI `6.2.1` to `6.4.0` and SDK `8.5.0` to `8.7.0`.
- Upstream rewrote `main` before this run; the target hash above was fetched again and locked before history rewriting began.

## Current Status

The stable local `main` series has been rebased onto the locked upstream target. Upstream is an ancestor of `HEAD`, no upstream commits are missing, and the branch contains 42 local commits: the original 41 stable commits plus this ledger. Dependency, migration, package test, focused type, and production build checks are complete. Remote publication, deployment, and public acceptance remain pending.

## Evidence, Decisions, And Failures

Record every conflict decision, failed check, compatibility repair, commit mapping result, deployment version, rollback point, and public acceptance result here. Do not convert missing or indirect evidence into a pass.

- The sequential 42-commit rebase completed without a textual conflict.
- `git range-diff` maps every one of the 41 pre-rebase local commits one-to-one to the rebased series with `=` equivalence. No local patch changed or disappeared.
- The independent Personal Node Alpha branch remains at `bb50e0591ee926a9850535508b80c37b0970b737` and was not rebased or included in `main`.
- Generated Alpha desktop artifacts were left untouched and locally excluded while validating stable `main`; they are not committed or treated as mainline source.
- `pnpm install --frozen-lockfile` passed. `pnpm --filter @cohub/api db:generate` reported no schema changes.
- The protocol, SDK, CLI, API, Agent, Web, Relay Worker, Relay Node, and Local Mode script suites passed 1,364 tests in total. `go test ./...` passed for the sandbox.
- The first API test run loaded an older built copy of `@cohub/core/board`; rebuilding protocol, core, and SDK removed that failure and the full API suite passed.
- The first Web test run exposed an upstream TypeScript constructor parameter property that Node's native strip-only loader rejects. `BoardItemValidationError` now declares and assigns `diagnostics` explicitly; the full Web suite and protocol typecheck pass with identical behavior.
- Agent typecheck exposed an inferred `unknown` return from the local session manifest reader. The reader now has an explicit validated `LocalSessionManifest | null` contract; its focused five-test suite passes and the only remaining Agent typecheck failures come from the unavailable private `@talesofai-billing/sdk` declarations.
- Protocol, SDK, CLI, Relay, API, and Web typechecks passed. Core and Agent cannot complete repository-wide typechecking in this checkout because the private `@talesofai-billing/sdk` package is unavailable; no non-billing type error remains in their output.
- The first Local Mode production build failed because upstream added the optional static `PUBLIC_MARKETPLACE_APP_ID` export without adding it to Local Mode setup. Local Mode now declares empty optional Marketplace and preview origins, and `pnpm local:build` completes while preserving the previous release until a staged build is complete.
- `git diff --check` passed, upstream remains an ancestor, and the rebased tree contains the upstream Marketplace/App Center surface.

## Next Action

Commit the evidence-backed compatibility repairs, refresh the locked upstream and origin refs, publish the recovery branch and rebased `main`, then run the atomic Local Mode release and public acceptance checks.
