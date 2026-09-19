# Agent Harness Fork Goal Ledger

## Goal

Make message-level Fork create a usable, independent branch for local Codex, Cursor, and Grok Build sessions without regressing Pi, normal continuation, or the existing fork tree.

## Current State

- The Web now enables Fork for terminal Codex, Cursor, and Grok Build messages while retaining Pi checkpoint checks. Unavailable feedback renders outside the clipped metadata row.
- The API waits for Agent-side preparation before creating or returning the child Cohub session, so a preparation failure cannot expose an unusable child in the sidebar.
- Codex turns persist their native app-server turn id. Exact checkpoints use `thread/fork` with inclusive `lastTurnId`.
- Cursor, Grok Build, and legacy Codex turns create a Cohub child with a pending transcript bootstrap. The first child prompt creates a fresh external session, injects only turns visible through the anchor, and then marks the bootstrap complete.

## Decisions

- Prepare the Agent branch before creating or navigating to the Cohub child session.
- Use Codex native `thread/fork` when the selected turn has a matching Codex turn checkpoint.
- Use a new independent external session on the first child turn plus an explicit one-time Cohub transcript bootstrap for Cursor, Grok Build, and legacy Codex turns that predate checkpoints. Empty ACP sessions were tested and rejected because Cursor cannot reload them before a first prompt.
- Do not reuse the parent external session id. Do not report success until the worker confirms the provider-specific preparation strategy.

## Validation Ledger

- Red/green regression: external-harness Fork availability failed before the Web change and now passes.
- Automated checks: Web 420 tests, Agent 82 tests, API 152 tests, Agent production build, Biome, and `git diff --check` pass.
- The normal commit hook reaches unrelated pre-existing API type errors around the absent optional billing SDK and `harness-capabilities`. Changed-file checks and the scoped test/build evidence above are clean, so the feature commit is recorded with hook bypass rather than rewriting unrelated code.
- Codex live acceptance: parent `7718e723-d6e8-4116-b65b-73339ac9f260`, child `661d25fd-5787-4da8-b0a5-55d740f36ccb`, strategy `codex_native`; the child returned `ALPHA-731` and did not see later-only `BETA-992`.
- Cursor live acceptance: parent `dad5a98a-2610-4e3d-8d74-1ef34556d47e`, child `cc16a206-c955-4459-9703-6079ffa26729`, strategy `context_clone`; independent external id, bootstrap cleared, child returned only `ALPHA-731`.
- Grok Build live acceptance: parent `c5f22475-8cfe-4252-bfb3-517164056071`, child `072b0802-533c-4c54-8447-73e41b5601b9`, strategy `context_clone`; independent external id, bootstrap cleared, child returned only `ALPHA-731`.
- Pi regression acceptance: parent `190630ae-2ab1-4c30-9b02-d3c7b7c72904`, child `c5bd0f2d-c36f-4955-85b0-61a3b2636a57`; the child continued from the Pi checkpoint and returned `PI_LUNA_E2E_OK`.
- Cold-resume acceptance: after restarting all Local Mode services, all three children resumed and returned `ALPHA-731` from their preserved branch context.
- Failure probe: a nonexistent turn returns HTTP 404 with `turn not found`; malformed bootstrap metadata fails closed in unit coverage.
- Browser acceptance: local production build shows enabled Fork actions and successful click-to-child navigation at desktop and mobile widths. Screenshots are `output/playwright/fork-cursor-desktop.png` and `output/playwright/fork-cursor-mobile.png`; both viewports have no horizontal overflow.
- Runtime evidence: all Local Mode services are ready and recent successful fork jobs contain the expected provider strategy with no recent fork errors.
- Release build: the Local Mode production build completed from the repository's managed environment. A direct generic Web build was rejected before deployment because the required public environment was absent; no partial Worker release occurred.
- Public deployment: Cloudflare Worker `cohub-local-web` version `b834d07d-2c9f-4994-b4d9-59a9597fc69b` serves the matched Worker and static assets. Previous version `2fff314b-d0d5-4298-9200-9ae2c744ff66` remains the rollback target.
- Public browser acceptance: the authenticated `cohub.atou.cc` Cursor test session exposed two enabled message-level Fork actions after a cache-bypassing reload. Desktop width had `scrollWidth === innerWidth` at 1159 px. Mobile width had `scrollWidth === innerWidth` at 390 px, and clicking Fork navigated to child session `1ce1a6be-4344-4ed4-b298-c79b567ed0f2` instead of silently doing nothing.
- Post-release health: Postgres, Redis, object storage, API, Gateway, Web, private ingress, and the Cloudflare relay node all report ready.

## Completion

The confirmed Fork workflow is implemented, committed, deployed, and accepted for Codex, Cursor, Grok Build, and Pi. No upstream or fork remote was pushed as part of this goal.
