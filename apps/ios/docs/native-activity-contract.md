# Native Activity Contract

## Product contract

The iPhone widget is a calm task board, not a miniature chat client. The small family shows one primary Space. The medium family shows up to three user-pinned Spaces in stable user order. Each visible Space is an independent deep link. The Live Activity represents one global pulse: an explicit Session focus wins, otherwise the most recently dispatched active Session wins. Alerts may call attention to another Session but never silently replace an explicit focus.

The interface uses the system typeface, Cohub's restrained red-orange accent, semantic status colors, and labels in addition to color. Motion is limited to system state transitions. The first scan target is the primary Space or focused Agent, followed by attention state, then elapsed time and the aggregate count of other work.

## Snapshot schema

The web host sends one complete snapshot to the native host. Partial patches are not accepted at this boundary.

```json
{
  "schemaVersion": 1,
  "revision": 42,
  "generatedAt": "2026-08-31T10:00:00.000Z",
  "freshness": "live",
  "boardSpaceIds": ["space-uuid"],
  "primarySpaceId": "space-uuid",
  "primarySessionId": "session-uuid",
  "otherActiveCount": 2,
  "spaces": [
    {
      "spaceId": "space-uuid",
      "spaceName": "macmini-chat",
      "origin": "local",
      "isPrimary": true,
      "activeAgentCount": 1,
      "attentionCount": 0,
      "activity": {
        "sessionId": "session-uuid",
        "sessionTitle": "Ship Focus Board",
        "turnId": "turn-uuid",
        "status": "running",
        "phase": "working",
        "harness": "codex",
        "model": "gpt-5.6-sol",
        "summary": "Building the widget extension",
        "startedAt": "2026-08-31T09:58:00.000Z",
        "updatedAt": "2026-08-31T10:00:00.000Z",
        "errorMessage": null
      }
    }
  ]
}
```

`boardSpaceIds` is the stable user order of at most three pinned Spaces. `spaces` is the snapshot catalog and contains every board Space plus the primary focus Space when that focus is not pinned; the primary focus never changes board membership or order. `freshness` is one of `live`, `recovering`, `stale`, or `offline`. Turn `status` preserves Cohub's source value: `queued`, `running`, `abort_requested`, `completed`, `failed`, `interrupted`, `merged`, or `cancelled`. `phase` may refine a real observed state as `dispatching`, `working`, `waiting_model`, `stopping`, `finished`, or `error`. Silence is never converted into waiting or progress. Unknown enum values and malformed timestamps reject the snapshot rather than falling back to a healthy state.

## Ordering and idempotency

Foreground and APNs Live Activity updates use the authoritative Turn update time as their shared ordering boundary. The native projection derives `content-state.generatedAt` from the primary activity's `updatedAt`, not from the Web snapshot generation time. APNs encodes the same lifecycle `observedAt` in both `aps.timestamp` and `content-state.generatedAt`. Missing, invalid, or non-monotonic source times are rejected rather than replaced with a local clock. A newer authoritative time wins across delivery paths. `revision` is monotonic only within one delivery source and rejects duplicates or out-of-order messages from that source; it is not a cross-source installation clock. The store writes a complete snapshot atomically to the App Group. An event becomes stale after its explicit `staleAt` in ActivityKit content or after the native freshness policy expires; stale content remains visible and labelled until a newer authoritative state arrives.

Live Activity `content-state` carries the focused Space's required `origin` as the strict enum `local` or `cloud`. Foreground projection and APNs use the same field so native actions never infer origin from a node, identifier shape, or the currently open page. Missing or unknown origins reject the state.

Space and Session display names must be real source values. Missing names never fall back to identifiers. Each name accepts at most 255 Unicode scalar values and 1,020 UTF-8 bytes, rejects control characters, U+2028, and U+2029, and remains subject to the final APNs 4,096-byte payload limit.

## Native bridge

The only accepted web-to-native message name is `cohubActivity`. It accepts `snapshot.replace`, `focus.replace`, `activity.start`, `activity.end`, `push.register`, and `state.reset` messages with schema version 1. `state.reset` ends the current Live Activity and clears the shared Widget snapshot before the native host acknowledges completion. The bridge accepts messages only from the main frame at the exact origin `https://cohub.atou.cc` on the default HTTPS port. It never accepts APNs topic, Apple team, owner identity, Relay node, or authorization material from message payloads.

Native-to-web delivery uses a single `cohub:native` custom event whose `detail` object contains schema version 1 and one of `bridge.ready`, `pushToStartToken.changed`, `activityPushToken.changed`, `activity.dismissed`, `state.reset.completed`, or `action.failed`. Token events carry a strict `development` or `production` environment. Tokens are handed to the authenticated same-origin page for Relay registration and are never written to logs, persisted by the page, or returned by Relay responses. Non-secret installation and activity identifiers are persisted per Cohub user so every credential-invalidation path can remove stale registrations. Logout and automatic auth invalidation wait for the native reset acknowledgement; failure remains visible and does not masquerade as cleanup success.

## Relay and APNs boundary

The Cloudflare Relay remains a single-owner Local Mode boundary. Device and activity registrations are bound to the verified Cloudflare Access subject, owner email, fixed node, installation, and activity. Client bodies cannot choose owner, node, bundle identifier, APNs topic, or Apple team. Registration responses return only identifiers, timestamps, and token fingerprints.

The Relay accepts only a small authoritative pulse projection. Raw turn bodies are not sent to APNs. Durable outbox state is written before an APNs queue job is scheduled. Starts are at-most-once across an unknown delivery result; updates and ends use bounded at-least-once delivery with a stable APNs request identifier, sending lease, Retry-After-aware backoff, maximum attempts, maximum age, dead-letter health, and garbage collection. APNs 400 token/topic errors and 410 responses invalidate a registration; 403 is surfaced as deployment failure; 429 and 5xx follow the bounded retry policy. Registrations bind their token environment, expire after the trusted Relay TTL, refresh while the native host is active, and are deleted before account exit.

## Deep links and actions

Space links use `cohub://spaces/<spaceId>?origin=<local|cloud>`. Session links use `cohub://spaces/<spaceId>/sessions/<sessionId>?origin=<local|cloud>` and may append one non-negative canonical `turn` sequence. Origin is required. Unknown origins, duplicate keys, unknown query keys, turn queries on Space links, unsupported hosts or schemes, missing identifiers, and cross-origin web URLs fail closed rather than routing against the currently selected backend.

Widget and Live Activity actions open the exact Space or Session. Pause and terminate actions may execute only with an authenticated, scoped command path. Until that credential path exists, the controls must open the target Session and expose the action there; they must not display a successful background action that was never accepted.
