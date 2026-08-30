# PWA stale client recovery goal ledger

## Goal

Make persistent Cohub browser and installed PWA clients recover from deployments without showing the generic 500 page or requiring users to clear site data. Preserve authentication, sessions, drafts, model preferences, and unrelated local state.

## Confirmed evidence

- 2026-08-30: The user reproduced `500 Internal Error` in normal desktop Chrome and Safari and in the iOS home-screen app. Incognito Chrome and ordinary iOS Safari remained usable.
- 2026-08-30: Local Mode service, API, gateway, web proxy, private ingress, relay node, Cloudflare tunnel, Postgres, Redis, and object storage were all healthy during the failure.
- 2026-08-30: The server logs contained no matching 500 response or server exception. The screenshot matches SvelteKit's generic client error presentation.
- 2026-08-30: The generated service worker waits for a `SKIP_WAITING` message, but the application only calls `navigator.serviceWorker.register("/sw.js")`; it never asks a waiting worker to activate and never reloads after `controllerchange`.
- 2026-08-30: The generated service worker precaches SvelteKit entry files, route nodes, and `_app/version.json`. The current registration is intentionally described as a conservative update that requires all tabs to close.
- 2026-08-30: The existing stale dynamic-import recovery stores a failed asset signature in session storage and never clears it after a successful boot.
- 2026-08-30: The public hostname was still serving Worker deployment `efc5897a` after the local service had been rebuilt. Restarting Local Mode alone does not update the `cohub-local-web` Worker and its matching static assets.

## Scope decisions

- Change only the web deployment/update lifecycle and its focused tests.
- Do not clear local storage, IndexedDB, authentication, drafts, preferences, or session data.
- Do not change APIs, agent runtimes, relay behavior, permissions, or unrelated UI.
- Preserve existing uncommitted work in the repository and edit around it.

## Current plan

- Add a testable service-worker update controller that requests immediate activation, bypasses HTTP cache for update checks, and reloads an already-controlled page at most once when the controller changes.
- Configure generated workers to activate immediately, claim clients, and stop precaching the deployment version file.
- Keep stale-import recovery bounded to one automatic retry, but reset its marker after a later successful app boot.
- Build, deploy, and verify the generated worker plus real browser behavior and relevant failure paths.

## Validation evidence

- Focused update-lifecycle tests were written before the implementation and initially failed because the controller did not exist. The completed implementation passes all five focused cases: waiting-worker activation, first install, installing-worker activation, surfaced update failure, and preservation of unrelated browser state.
- `pnpm --filter web test` passes all 405 web tests.
- Biome passes all changed update-lifecycle files, and `git diff --check` passes.
- The production web build succeeds. The generated worker calls `skipWaiting()` and `clientsClaim()`, no longer precaches `_app/version.json`, and emits no-store headers for the deployment version endpoint.
- The local service was rebuilt and restarted successfully; API, gateway, web, private ingress, relay node, Postgres, Redis, and object storage all report ready.
- The matching web Worker and static assets were deployed together as version `07666de8-bcc8-4881-b600-4ac7e5ada2c4`.
- A real persistent, authenticated browser profile began with an active old worker, a waiting worker, a deliberately stale dynamic-import marker, one auth token, and three drafts totaling 172 bytes. One normal reload activated the new worker. After a 30-second stability window there was one active controller, no waiting or installing worker, no reload loop, and the stale marker was cleared while the auth token and all three drafts remained unchanged.
- The live `cohub.atou.cc` session returns HTTP 200 with the current app entry and early recovery bootstrap. The public version endpoint returns build `1788063475332`; the worker claims clients and does not precache the version file.
- Repeated update checks converge without another reload. A real offline interval left the already-loaded session, active worker, auth token, and drafts usable, then recovered when connectivity returned.
- The authenticated live session was inspected at desktop and mobile viewport widths. Both rendered the real session with an active worker, no 500 page, no blank shell, and no horizontal overflow.
- Web type checking reaches two unrelated pre-existing test-fixture errors in `models-status-cache.test.ts` and `palette-overview-local.test.ts`; no changed recovery file reports a diagnostic.

## Blockers

None.

## Next action

Complete. Keep the production Worker and its assets in the same deployment whenever a web build changes.
