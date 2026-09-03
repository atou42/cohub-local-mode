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

The stable local `main` series has been rebased onto the locked upstream target. Upstream is an ancestor of `HEAD`, no upstream commits are missing, and the original stable local patch series remains intact. The rebased branch, recovery branch, atomic Cloudflare release, restored Mac service, public UI, all four harnesses, and both federated write directions have passed acceptance. This final evidence update is the only publication step still pending.

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
- Remote recovery branch `backup/pre-upstream-rebase-20260903` preserves `c46f4a99103d2659a44b47852b5eabb8fc12771c`. `origin/main` was updated with an explicit lease from that exact old hash to rebased commit `1414ae14072089724527f269f4332aa4f55ee6ad` before final runtime acceptance.
- The first release attempt stopped before publication when the staged Web build ran out of host space. The current release remained unchanged. Generated failed build directories were removed and the next build completed.
- The successful release deployed Relay Worker `1bfd865d-83f2-49b7-b0eb-b1ed423a05be` with source digest `2153cba2751e2576b61640fa7fbae1ee369bb9e66738bd4d9c713b974d7cb77c`, plus Web Worker `05ae4a41-ea25-430e-997b-72ee1c341256` with Web build `1788400442013`. Deployment annotations and the public version endpoint match the local artifacts.
- Service restart exposed existing Colima image-layer I/O errors and stale listeners on the reserved Web and private-ingress ports. A clean Colima stop/start restored the image layers and healthy data services; the stale Cohub Web listener and unrelated temporary port-4180 server were terminated before the managed service reclaimed both ports. No application data directory was removed or replaced.
- The managed Mac service, Postgres, Redis, object storage, API, Gateway, Web, app shell, private ingress, Cloudflare relay node, and persistent Tunnel all report ready or running. The authenticated public relay reports protocol 3 and `connected: true`.
- Authenticated public catalogs returned HTTP 200 for Pi, Codex, Grok Build, and Cursor. Cursor exposes only Grok 4.6 and Claude Fable 5.1 with their supported effort choices; Codex exposes its eligible Fast tier.
- Real public Pi Session `6055ed5b-00b6-4d23-9c01-1811c52c51f6`, Codex Session `37c61fc4-ee63-47d8-94d6-e302f53bf577`, and Grok Build Session `3e77208a-7c48-4226-a0d9-b2b8b4f1da37` completed with their exact acceptance replies and selected model metadata.
- Cursor's newly installed `2026.09.02-c22c1a3` binary no longer completed the ACP initialization used by Cohub; two public turns failed explicitly rather than hanging silently. A direct probe proved the retained `2026.08.31-4057e58` binary completes initialize, authenticate, and session creation in about 52 seconds, with authentication alone exceeding the old 30-second request limit. Local Mode now allows 90 seconds for Cursor startup requests and catalog discovery, and this Mac pins Cohub's `CURSOR_AGENT_COMMAND` to that retained ACP-compatible binary. Public Cursor Session `a8e1b784-2097-41d6-8f2f-4321a22353cb` then completed with Claude Fable 5.1, High effort, and exact reply `REBASE_CURSOR_RETRY_OK`.
- Public Local-to-Cloud Session `7ed2c87b-d858-489c-9815-5d21cf27da3` wrote, read back, and deleted `rebase-local-to-cloud-1788404000.txt` in Cloud Space `5cfdff53-424b-483f-b114-c2d4a5e86338`; an independent Cloud CLI read confirmed cleanup.
- A deliberately unregistered CLI-only Local mention in Cloud Session `d9ac51ea-1738-41fb-a3ac-22e5cbb8f1d9` failed closed with HTTP 403 `local_space_not_mentioned` and created no file. The same request with the deployed Web client's structured mention metadata and scoped bridge context passed in Cloud Session `e8c6cecd-42c1-4425-9937-86648c984b15`: it wrote, read back, and deleted `rebase-cloud-to-local-1788406000.txt`, and an independent local filesystem check confirmed cleanup.
- Authenticated desktop 1440x900 and mobile 390x844 captures of Local Space `d5bb1cb3-2154-4037-944f-554e83200df5` rendered the application, workspace, Local identity, files, and composer without a blank/500 state or horizontal overflow. The desktop also shows the upstream Apps surface.

## Next Action

Commit and push this final evidence plus the Cursor compatibility repair. Then verify the local and remote `main` hashes match and close the goal.
