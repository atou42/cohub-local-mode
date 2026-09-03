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

Baseline and recovery refs are locked. The rebase, validation, remote publication, deployment, and public acceptance are pending.

## Evidence, Decisions, And Failures

Record every conflict decision, failed check, compatibility repair, commit mapping result, deployment version, rollback point, and public acceptance result here. Do not convert missing or indirect evidence into a pass.

## Next Action

Commit this ledger to local `main`, replay the complete local series onto the locked upstream target, and audit the resulting history before running validation.
