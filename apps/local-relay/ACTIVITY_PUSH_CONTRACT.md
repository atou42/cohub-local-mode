# Activity Push Contract

APNs and foreground snapshots share one ordering boundary. Receivers compare the authoritative event time: APNs `aps.timestamp` and `content-state.generatedAt` encode the same lifecycle `observedAt` value. A newer authoritative timestamp wins across delivery paths. `revision` only deduplicates messages emitted by one delivery source; it is not an installation-wide or cross-source clock.

`spaceName` and `sessionTitle` contain at most 255 Unicode scalar values and at most 1,020 UTF-8 bytes each. Empty values, unpaired surrogates, C0/C1 controls, U+2028, and U+2029 are rejected. Missing names make a lifecycle projection unavailable for APNs rather than producing fallback text. The serialized APNs payload remains subject to the final 4,096-byte deployment limit.

Device and activity registrations expire after the trusted Relay TTL. The foreground client refreshes them every five minutes and logout sends DELETE. A crashed or disconnected client can remain registered for no longer than the configured 24-hour window.

## Owner watch preferences

The owner client writes the global Agent Pulse scope with `PUT /relay/v1/nodes/mac-mini/activity/preferences/:installationId` and removes its copy with `DELETE` on the same path. The PUT body contains exactly `watchedSpaces` and `focus`. Each watched Space is `{ spaceId, origin }`, where `origin` is `local` or `cloud`; at most three watched Spaces are accepted. `focus` is either `null` or `{ spaceId, origin, sessionId, explicit }`. A focused Space may be outside the three watched Spaces. Space, Session, and installation identifiers remain UUIDs.

Cloudflare Access supplies the owner subject and email. The Relay supplies the fixed node ID and configured Cohub `OWNER_USER_ID`; none of those identity fields are accepted from the public request body. `OWNER_USER_ID` accepts the Cohub 32-hex account ID returned by `/api/me` or a standard UUID. Preferences use the same trusted TTL as APNs registrations.

APNs device and Live Activity token registrations contain only `token` and `environment`. They never carry focus or watched Space filters. This keeps delivery credentials separate from the account-level selection policy.

One owner has one global Agent Pulse. The newest nonexpired installation preference is authoritative, ordered by server `updatedAt` and then installation ID. Older installations remain stored for idempotent delete and expiry, but cannot widen the current scope. An identical refresh extends its expiry without changing its preference revision. A changed preference advances its revision.

## Node watch lease

After durable preference storage, the Relay sends `activity-watch.replace` to the authenticated fixed node. The message carries the configured owner ID, origin-qualified watched Spaces and focus, a monotonic global revision, a SHA-256 scope digest, the preference expiry, and a short lease expiry. The node acknowledges the exact revision and digest with `activity-watch.ack`; mismatched acknowledgements are rejected and the current snapshot is resent. The Relay also resends the current snapshot after every node reconnect and renews the short lease while an effective preference exists.

Deleting or expiring the authoritative preference selects the next newest nonexpired installation. If none remains, the Relay persists and sends an empty replacement before the node collector's prior lease can remain active. Lifecycle projection and active counts are then filtered by the effective origin-qualified scope; explicit Session focus requires an exact origin, Space, and Session match.
