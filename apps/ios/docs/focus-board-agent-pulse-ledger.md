# Focus Board and Agent Pulse Goal Ledger

## Goal

Deliver an iPhone Focus Board widget and one global Agent Pulse Live Activity backed by real Cohub state, with explicit focus selection, reliable deep links, honest stale/offline behavior, and no regression to the existing native web host.

## Current status

- The iOS project now contains the Cohub app, a Widget extension, App Group storage, push entitlement, Focus Board small and medium Widgets, and one global Agent Pulse Live Activity.
- The native bridge, Web projection, Local Relay lifecycle watcher, registration API, durable APNs outbox, and development/production token routing are implemented and covered by automated tests.
- The medium Widget renders up to three pinned Spaces in stable order with independent deep links. Explicit Session focus remains independent from board membership.
- Account exit and automatic credential invalidation delete Relay registrations, wait for a native reset acknowledgement, end the Live Activity, and clear the shared Widget snapshot. Only non-secret registration identifiers persist in Web storage.
- The foreground client persists an origin-qualified Focus Board preference independently from APNs tokens. The fixed Relay sends a short-lived watch snapshot to the Mac mini, which reconciles and listens to only the selected Local and Cloud Spaces with the host Cohub account. Cloud credentials never leave the Mac.
- A separate `CohubFree` app-only scheme can be signed by an Apple Personal Team for immediate use on an iPhone. It intentionally excludes the Widget, App Group, push entitlement, and native Activity bridge; the full `Cohub` target is unchanged.
- The iPhone Air Simulator builds Debug and Release with the Widget extension embedded. Unsigned Release builds for the real iPhoneOS arm64 target also pass for both `Cohub` and `CohubFree`. Real-device signing and APNs delivery remain unavailable because this Mac has no valid Apple signing identity, provisioning profile, APNs key, or connected physical device.

## Confirmed decisions

- Cohub exposes one global Live Activity rather than one activity per agent.
- A manually focused Space or Session cannot be displaced by unrelated activity. Without a manual focus, the most recently dispatched Session becomes the focus.
- Other running work is summarized. Failures and requests for input may alert the user but do not silently steal focus.
- The small widget shows one focused Space. The medium widget shows three manually ordered focused Spaces, and each row deep-links to that Space.
- Widgets are a stable board snapshot. The Live Activity is the real-time surface.
- Widget and Live Activity state must come from the same persisted native state model and must expose stale/offline state instead of inventing progress.
- Existing user-scoped Space pins are the source of the Focus Board set. A separate explicit Session focus controls Agent Pulse without changing Space pin semantics.
- Snapshot `boardSpaceIds` preserves up to three pinned Spaces in user order, while the snapshot catalog may additionally contain an unpinned primary Pulse Space. This prevents Session focus from silently changing the Widget board.
- `apps/ios/docs/native-activity-contract.md` is the implementation contract for snapshot shape, ordering, bridge security, APNs registration, and deep links.

## Evidence collected

- `apps/ios/Cohub/Cohub.xcodeproj/project.pbxproj` contains the full `Cohub` app, `CohubWidgets`, and the entitlement-free `CohubFree` app target. All use deployment target iOS 17.0.
- `apps/ios/Cohub/Cohub/CohubWebView.swift` uses the persistent website data store and disables page bounce and back-swipe navigation.
- `apps/ios/Cohub/Tests/main.swift` verifies current Cohub URL routing and rejects unsupported custom routes.
- Repository root `AGENTS.md` requires local-first caching, reliable server refresh, efficient realtime sync, and concise English UI copy.
- The existing `user:pinned` Space label already persists and synchronizes user-chosen important Spaces across clients.
- Authoritative Agent execution state is the Turn status. Session status and Relay command delivery status cannot substitute for it.
- Local Relay now persists a restricted authoritative lifecycle projection for queued, running, stopping, and terminal Turn states. It refuses missing or invalid display names rather than inventing content.
- The installed Xcode is `/Applications/Xcode.app` version 26.6. Commands currently need `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` because the active developer directory points to Command Line Tools.
- The machine has a free Personal Team but no valid signing identity or provisioning profile. App Groups and APNs therefore cannot be validated on a physical device yet; Simulator work remains available.

## Open questions and risks

- Physical-device acceptance still requires a paid Apple Developer team, valid App Group and Push profiles, APNs Key ID and private key, a matching Team ID, and a Dynamic Island iPhone.
- Background Local and Cloud collection depends on the Mac mini and its authenticated Cohub CLI session remaining online. When that trusted collector loses its short Relay lease, it stops reading and the Activity becomes stale rather than inventing progress.
- Real Cloudflare Queue redelivery, APNs failure injection, push-to-start behavior, token invalidation, and notification timing require staging and physical-device evidence.

## Validation record

- Baseline `pnpm --filter @cohub/local-relay test` passed 23 tests before Relay changes.
- Baseline focused Web tests for Space picker and Local Relay passed 2 tests before native bridge changes.
- Baseline iPhone Air Simulator build succeeded with Xcode 26.6 and `CODE_SIGNING_ALLOWED=NO`. It emitted Swift 6 warnings that two WebKit delegate methods do not exactly satisfy their optional `@Sendable` requirements; the iOS implementation must not preserve those warnings unnoticed.
- Final Relay suite passed 65 tests, typecheck, and lint. It rejects unknown lifecycle fields and revokes pending or in-flight Activity delivery before native account reset without breaking normal Activity dismissal and later push-to-start. Delayed deletion or expiry for an old Activity cannot clear a newer Activity's start marker. Final Relay Node suite passed 73 tests, including exact account verification, mixed Local and Cloud origin isolation, realtime wakeup plus authoritative reconciliation, lease expiry, corrupt state, write-failure recovery, real display names, authoritative time ordering, and no fabricated timeout completion.
- Final Web suite passed 460 tests; the focused native-activity suite passed 38 tests. Web typecheck reports only two pre-existing test fixture errors outside this feature in `models-status-cache.test.ts` and `palette-overview-local.test.ts`.
- Native Swift logic tests passed. Debug and Release iPhone Air Simulator builds passed, both embed `CohubWidgets.appex`, and their built push environments resolve to `development` and `production` respectively.
- `CohubFree` Swift logic checks and Debug/Release iPhone Air Simulator builds passed. Its build graph contains no Widget dependency, app extension, App Group, push entitlement, or Activity bridge. The installed Simulator app keeps Cohub below the native safe area with no status-bar overlap.
- Unsigned Release iPhoneOS builds passed for both app targets. `CohubFree` produces a standalone arm64 app with no embedded extension; the full `Cohub` app embeds the arm64 `CohubWidgets.appex`.
- Independent security and feature reviews drove fixes for exact WebKit origin checks, account reset acknowledgement, cross-source event ordering, APNs retry bounds, long display names, registration expiry, and watcher persistence failures.

## Next action

Install `CohubFree` from the MacBook with the user's Personal Team for the immediate app experience. Obtain Apple Developer signing and APNs credentials before installing the full target, configure the Relay owner and APNs secrets, then run the physical-device acceptance matrix for Widget refresh, Dynamic Island start/update/end, app-killed Local and Cloud delivery, account reset, stale/offline display, and exact origin-preserving deep links. Production deployment and push remain out of scope until those credentials exist and the user explicitly authorizes deployment.
