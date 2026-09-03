# Local Release Protocol And White-Screen Ledger

## Goal

Eliminate production blank screens and Relay protocol drift at `cohub.atou.cc`. A release is complete only when fresh and already-open clients recover without manual cache clearing, Web/Relay/Node compatibility is mechanically gated, production opens on desktop and mobile, and a real Local Agent turn plus intermediate output succeeds.

## Scope And Invariants

- Scope is limited to Web, Relay Worker, Relay Node compatibility, stale-client recovery, release gates, tests, publication, deployment, and production acceptance.
- Preserve authentication, local data, drafts, Sessions, Pi, Codex, Grok Build, Cursor, model and effort preferences, intermediate output, Local/Cloud federation, files, and desktop/mobile layouts.
- Do not include Personal Node Alpha, rewrite unrelated upstream code, clear user state, or use a fallback to conceal malformed protocol, missing assets, authentication failures, or broken release state.

## Initial Evidence

- User reported a white screen immediately after the `v2.39.0` Local Mode release.
- All managed Local services report ready. The persistent Tunnel and public Relay node report running and connected, so the incident is not a complete backend outage.
- A newly opened authenticated shared-Chrome page currently renders the Local Space with HTTP 200. The reported blank screen is therefore client-state or release-transition dependent rather than universal.
- The same production page emits `[local-relay] event message protocolVersion is not 2` while public Relay health reports protocol 3.
- `apps/local-relay/src/protocol.ts` and `apps/local-relay/node/protocol-compat.mjs` declare protocol 3. `apps/web/src/lib/local-relay-events.ts` and its tests still declare protocol 2.
- Current release gates compare Relay Worker health with Relay Node constants but do not compare the built Web event client. The previous release passed while shipping this mismatch.
- Current early Service Worker activation runs from `app.html`, and post-boot dynamic-import recovery runs from `hooks.client.ts`. A failure before the current client module boots must be proven recoverable independently of that hook.
- Blocking every `/_app/*.js` request in an authenticated shared-browser page reproduced the reported failure as HTTP 200 with an empty body and `data-home-redirect="1"`.
- The three entry assets from the prior production build returned HTTP 404, proving that a still-open client could lose required hashed resources during a release.

## Current Status

The two independent causes are reproduced and fixed locally. Browser events remain on wire protocol 2 while the Node command plane remains on protocol 3 and event schema 1. The Web build now retains immutable assets for 30 days, refuses incomplete manifests, installs a stable preboot recovery script, waits for Service Worker control, limits automatic recovery to Cohub application assets, and shows an independent error surface after one failed retry. The release now refuses an unproven retention baseline and runs protocol and Web recovery gates before any remote deployment.

## Decisions

- Treat protocol drift and white-screen recovery as distinct acceptance requirements even if one triggers the other in the reported client.
- Do not deploy a version-number-only edit without adding a release gate that would have rejected the current broken combination.
- Preserve the user's cached authentication and application state during recovery.
- Treat the browser event plane and Node command plane as separate compatibility contracts. Changing the fixed `3/2/1` contract requires a separately designed backwards-compatible migration.
- Preserve old assets only from an auditable local release lineage. A clean or mismatched build must stop before deployment rather than silently discarding the public baseline.
- Never reload for third-party scripts, Space styles, or a generic Safari `Load failed` rejection.

## Validation Required

- A failing automated check must demonstrate the current Web/Relay/Node protocol mismatch before the fix and pass afterward.
- Relevant Web, Relay Worker, Relay Node, release-script tests, typechecks, and production build must pass.
- Release validation must cover a fresh authenticated page, an already-controlled stale page, a waiting Service Worker, an unavailable old immutable asset, repeated refresh, reconnect, desktop, mobile, one real Local Agent turn, and persisted intermediate output.
- A wrong protocol or missing required asset must surface an explicit recoverable error and must not become an empty body or infinite reload.

## Validation Evidence

- Protocol mismatch regression was observed red (`2 !== 3`) before the fix; the cross-boundary contract and browser frame fixtures now pass.
- Protocol package tests and typecheck pass: 86 tests.
- Relay Worker tests and typecheck pass: 76 tests. Relay Node integration tests pass: 76 tests.
- Web typecheck passes with 0 errors and 0 warnings. The full Web suite passes: 501 tests.
- Release, deployment, retention, route, and failure-path tests pass: 33 checks across the focused commands.
- A complete `pnpm local:build` passed. The candidate contains `preboot-recovery.js` and both entry assets from production build `1788411262799` after producing build `1788416852741`.
- The current public build `1788411262799` is recorded with 483 immutable asset paths and SHA-256 digests in the candidate's validated retention lineage. The release preflight accepts it and rejects missing, empty, modified, expired, future-dated, colliding, corrupt, or mismatched lineage and assets.

## Blockers

Production commit, push, deployment, and live acceptance remain.

## Next Action

Commit and push the verified change, run the atomic Local Mode release, then complete fresh, stale, desktop, mobile, Relay health, retained-asset, and real Local Agent acceptance against `cohub.atou.cc`.
