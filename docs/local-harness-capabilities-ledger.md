# Local Harness Capabilities Goal Ledger

## Goal

Expose each local harness's real commands, skills, and instruction context in Cohub, add native Codex goal management, and keep slash discovery responsive over a high-latency Tunnel through validated local-first caching.

## Delivered behavior

- The local API exposes a versioned capability catalog for the selected Space and harness. The route is local-node only, permission checked, bounded by a 15-second discovery timeout, and cached on the server for 60 seconds.
- The browser restores a strictly validated catalog from local storage before refreshing it in the background. Keys include the authenticated user, Space, harness, and schema version. A failed refresh leaves the last valid catalog usable and shows the failure in the composer instead of hiding it.
- Prompt-template and Pi skill caches use the same authenticated-user isolation so one account cannot render another account's cached catalog.
- The composer keeps harness capability surfaces separate. Pi receives Cohub and machine Pi skills, Codex receives `/goal` and enabled Codex skills with their native `$skill-name` syntax, and Grok receives only commands that its ACP transport can execute reliably.
- A session still locks its harness after the first submitted turn. Changing the model or effort stays within that harness.

## Harness behavior

### Codex

- Skills are discovered live from Codex app-server `skills/list` for the Space working directory. Disabled or unknown-scope entries are rejected.
- `/goal <objective>` persists the objective through Codex app-server and immediately continues execution in the same turn.
- `/goal status`, `/goal clear`, `/goal pause`, and `/goal resume` use the real persisted goal state. Invalid commands fail visibly.
- Machine Codex skills remain Codex-only and are not presented as Pi or Grok commands.

### Pi

- Local Mode defaults the user instruction source to `~/.codex/AGENTS.md` and the compatible skill source to `~/.agents/skills`.
- The Pi bridge synchronizes the compatible skill catalog for Cohub discovery and injects the real host paths into the sandbox environment. File reads under those mounted skill paths are accepted by the local sandbox boundary.
- Existing platform, Mod, and workspace skill behavior remains intact. Cloud Spaces do not use these local host paths.

### Grok Build

- Commands are discovered from the Grok ACP initialize response rather than maintained as a static product list.
- The displayed ACP-safe set is `/context`, `/session-info`, `/deep-research`, `/workflow`, and `/goal`.
- Grok 1.0.5 advertises `/context` but emits no assistant message for it over ACP. Local Mode routes that exact command to Grok's native `/session-info`, which returns the requested context usage and session details.
- `/always-approve` is not displayed because Local Mode permissions are fixed by the Cohub session access mode. `/compact` is not displayed because the current ACP implementation does not complete reliably. Neither unsupported path is presented as usable.

## Failure behavior

- Capability discovery timeouts, malformed catalogs, permission failures, and refresh failures are surfaced. Bad cached structures are ignored rather than converted into empty success results.
- Harness startup, stderr, thinking, tool use, reconnects, and completion remain visible through the existing progress stream.
- A harness turn that ends without an assistant message still fails explicitly. The Grok `/context` compatibility routing fixes the confirmed upstream empty-message case without weakening that invariant.
- Local sandbox build failures stop Local Mode startup. The runner no longer silently falls back to a pinned CDN sandbox binary that lacks the host skill mounts.

## Acceptance evidence

- Protocol and SDK type checks passed after adding the capability catalog API.
- Agent tests passed with 67 tests, including the Grok command compatibility regression.
- API tests passed with 140 tests, including the Grok catalog transport filter regression.
- Web tests passed with 344 tests, and the production Local Mode build completed.
- Sandbox tests for `rpc` and `env` passed. A live Pi turn read a reference file under the mounted machine skill directory and returned the expected content.
- A live Codex turn set and executed a persisted goal. Status and clear were exercised afterward.
- A live Grok ACP probe confirmed visible output for `/session-info`, `/goal`, `/workflow`, and `/deep-research`; it also reproduced the empty `/context`, empty `/always-approve`, and non-completing `/compact` behavior that the catalog and runtime now account for.
- With the capability request forced offline in the browser, a warm Codex cache restored `/goal` in under one millisecond and kept it usable while rendering the refresh error.
- Authenticated desktop and mobile checks on the public Tunnel showed the Pi skill menu, Codex `/goal` and `$` skills, Grok command isolation, and stable responsive layout.

## Deployment record

- Public Worker: `cohub-local-web`
- Worker version: `75ae0201-a179-4923-b15f-c5a5c701abf6`
- Deployed client version observed through the authenticated shared browser: `1787742927640`

## Remaining boundary

Grok ACP 1.0.5 does not currently provide a reliable client operation for `/compact` or a permission-safe operation for `/always-approve`. They should only be exposed after the upstream transport supports an acknowledged result that matches Cohub's session permission model.
