# Android UI performance: sidebar and timeline

## Scope

The desktop Sidebar remains mounted inside the app shell on compact screens.
CSS hides it, but previously its Space loaders, realtime subscriptions and DOM
remained active. The mobile drawer mounts a separate Sidebar only while open.
This affects the shared shell used by Chats, Spaces, Account and Space sessions.

The desktop instance now retains shortcuts and recent-space tracking while
rendering and subscribing only when visible. The existing compact-shell query
controls the lifecycle; opening the mobile drawer still activates its own
instance. Space data reloads through the existing cache-first loaders when the
sidebar becomes visible again. The redundant on-mount Space request was removed;
the existing reactive loader owns that request.

No changes were made to data persistence, route transitions, list virtualization,
stream reveal timing, or scroll restoration.

## Timeline snapshots

Each chat host now owns a timeline builder that reuses message projections for
unchanged turn objects and the deduplicated ordering for unchanged turn arrays.
Workspace state uses immutable snapshots; replacing a turn rebuilds its messages,
even when its ID and timestamp are unchanged. Streaming state is still evaluated
on every build, including completion, process cards and the live assistant tail.
WeakMap keys avoid retaining discarded snapshots solely for this cache.

The existing streaming merge suite exercises the cached builder. Temporary checks
also compared cached and uncached output across patches, history corrections,
completion, aborts, optimistic replacement, prepends and session changes.

A local Node microbenchmark alternated cached and uncached runs after warmup;
values below are medians of nine batches of 3,000 builds with changing stream text.
Fixtures use short plain-text messages. These measure construction only, excluding
Svelte updates, layout and Android WebView execution.

| Loaded turns | Uncached | Cached | Reused unchanged message objects |
| --- | ---: | ---: | ---: |
| 30 | 23.65 ms | 13.36 ms | 59 / 59 |
| 500 | 293.64 ms | 147.78 ms | 999 / 999 |

The final turn is streaming, so its persisted assistant message is hidden and
its live preview is rebuilt. The table does not imply equivalent page speedups.

## Verification

Compared the base and modified Sidebar in an isolated Svelte page with mocked
SDK user-event subscriptions and no authenticated account. Tested with desktop
Chromium; these are lifecycle measurements, not Android frame-rate results.

| Scenario | Sidebar DOM instances | Active SDK user-event subscriptions |
| --- | ---: | ---: |
| Base, compact 412 px, drawer closed | 1 | 2 |
| Modified, compact 412 px, drawer closed | 0 | 0 |
| Modified, resized to desktop 1280 px | 1 | 2 |
| Modified, resized back to compact | 0 | 0 |
| Modified, compact drawer opened | 1 | 2 |
| Modified, drawer closed after exit transition | 0 | 0 |
| Modified, desktop instance unmounted | 0 | 0 |

The two subscriptions include the reference-counted session-store subscription.
Other active components can retain that shared subscription in the real app.
Temporary fixture and baseline component were removed after verification.

Web suite: 429 tests passed after removing the temporary cache-specific tests.
Web lint passed; Svelte typecheck reported zero
errors and warnings. Full authenticated navigation was blocked locally by the
OIDC redirect URI allowlist, so that coverage is not claimed.

## Device follow-up

Use the same release APK, production-optimized Web build, WebView version,
account and data for before/after captures. Record cold and repeat navigation
separately. Cover all three tabs, opening and returning from a Session and Space,
long conversation scrolling, streaming while typing, keyboard opening, and the
mobile sidebar. Check request counts, long tasks, frame timing and retained DOM.
Verify realtime updates while the drawer is closed and fresh contents on reopen.
Android startup and interaction timings remain unmeasured in this sandbox.
