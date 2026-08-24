# Local Mode Connectivity and Harness Models Goal Ledger

## Goal contract

Upgrade the Mac mini Local Mode deployment so the existing Cohub client prefers a verified direct Tailscale path to the local node and falls back to the protected Cloudflare public path when the private path is unavailable. Keep all local files, context, sessions, credentials, and execution on the Mac mini. Pi, Codex, and Grok Build must each expose their own live model and effort catalog, pass the selected values to the real harness on first and resumed turns, and persist the model and effort that actually ran. The session harness remains locked after the first turn. Do not open an upstream Cohub pull request.

Completion requires a real deployed flow, not only unit tests. A verified direct Tailscale path must load the model, session, and file surfaces with p95 at or below 1.5 seconds over ten runs, with common local API requests at p95 at or below 200 milliseconds. Cloudflare fallback, owner-only access, service restart recovery, catalog failure behavior, unsupported effort rejection, resumed turns, and desktop/mobile UI must also pass.

## 2026-08-24 baseline

Status: active.

Repository: `atou42/cohub-local-mode`, branch `main`, clean at `932ede5808085d8bc7ec33eefc169611b987d98e` before this goal begins. `upstream` remains `talesofai/cohub`; no upstream PR is allowed.

Public deployment: `https://cohub.atou.cc`, protected by Cloudflare Access for the owner. Local Mode and the named Cloudflare Tunnel are persistent launchd services.

Connectivity evidence: local HTTP endpoints respond in roughly 3-13 ms. The same authenticated APIs over the Cloudflare Tunnel vary from roughly 0.2 seconds to 16 seconds. A cache-disabled public reload took 15.644 seconds, while the hosted Cohub client completed the comparable reload in 1.215 seconds. Static immutable assets already return Cloudflare cache hits in roughly 80 ms, so the dynamic Tunnel path is the observed bottleneck.

Tailscale evidence: `/Applications/Tailscale.app` is installed. The local backend currently reports `NeedsLogin`, no tailnet, and no peers. Network check reports UDP available and destination-independent NAT mapping, which are favorable for direct peer connectivity. Public DERP measurements are unsuitable as the performance path: Los Angeles about 153 ms, Tokyo about 201 ms, and Hong Kong about 330 ms. Direct peer connectivity must be proven after login; relay-only connectivity does not satisfy this goal.

Harness catalog reproduction: `GET /api/models` currently exposes only the Pi catalog, which contains `anthropic/claude-sonnet-4-6`. The Web model selector is not scoped by `agentHarness`, so selecting Codex or Grok Build still shows Sonnet.

Harness execution reproduction: `apps/agent/src/external-harness-protocol.ts` constructs Codex and Grok Build argv without the requested model or thinking level. `apps/agent/src/processor.ts` branches to the external harness before resolving or forwarding requested model and effort. The API also validates every selected model against the Pi model registry. This proves that the current UI selection cannot control Codex or Grok Build execution.

Current live catalogs: `~/.codex/models_cache.json` contains seven visible Codex models with per-model effort options and one hidden internal model. The visible current default family includes GPT-5.6 Sol, Terra, and Luna. `grok models` reports `grok-4.6` and `grok-4.5`; Grok Build and xAI documentation support low, medium, high, and xhigh effort for these models. Pi must continue to use the Cohub model configuration rather than either external catalog.

Failure policy: missing, malformed, stale, or unavailable external catalog data must produce an explicit unavailable/error state. It must never fall back to the Pi catalog or silently substitute Sonnet. A model or effort that is not offered for the selected harness must be rejected before execution.

## 2026-08-24 implementation checkpoint

Harness catalogs now have a fail-closed Local Mode contract. Codex is read from its current `models_cache.json`, filtered to visible models, ordered by priority, and mapped to each model's exact effort menu, including Ultra where the installed Codex advertises it. Grok Build is read from its structured cache and preserves the real difference between Grok 4.6 and 4.5 effort menus. Missing, malformed, stale, duplicated, cross-harness, and unsupported data have explicit errors; none can fall back to Pi or Sonnet. Focused parser and selection tests pass. A live read returns the seven Codex models in about 65 ms and both Grok models in about 35 ms.

The Web catalog is keyed by both Space origin and harness. Changing the draft harness clears the old model, loads the matching catalog, shows loading or a retryable explicit error, and chooses the catalog default effort when the user has not overridden it. Started Sessions still derive and lock their stored harness. Ultra was added to the shared prompt and persistence contract so a Codex model that advertises it can be selected, sent, and restored instead of being lost between layers. Web typecheck passes with the Local Mode public environment supplied, and focused Web route/model tests pass.

Codex and Grok Build now receive the selected model and effort as argv-safe arguments on both initial and resumed turns. The Agent refuses an external turn whose validated model or effort is absent, records the chosen model under its harness provider, and persists the effective effort into the completed Turn. Focused reducer and argv tests pass for initial and resumed execution.

A private-first browser route manager and loopback-only ingress are implemented. The client probes the Tailscale HTTPS origin, routes Local Mode API and realtime traffic there when healthy, and returns to the protected public origin when the private route cannot be reached. HTTP application errors remain visible; only idempotent requests retry after a network failure, so a write cannot be duplicated. The private health probe and owner Tailscale identity checks are implemented and tested. Tailscale itself is installed but currently disconnected; enabling the VPN is still awaiting the required action-time confirmation, after which the real tailnet hostname, Serve rule, direct-peer proof, and performance measurements can be completed.

Next action: finish Local Mode environment and private ingress deployment, then enable Tailscale with user confirmation and run real direct-path, fallback, execution, restart, and visual acceptance checks.

## 2026-08-24 deployed Tunnel checkpoint

The production build completed and the persistent Local Mode service restarted with Postgres, Redis, object storage, API, Gateway, Web, and the loopback private ingress all ready. The private browser origin is intentionally unset for now, so current use stays on the protected Cloudflare Tunnel without paying an unsuccessful private probe on each cold client load. Tailscale is authenticated as `sobighead.c@gmail.com` and the Mac mini has the tailnet name `mac-mini.tail68463a.ts.net`, but Serve and direct-peer performance remain deferred by the user until another tailnet device is available.

The deployed API now returns separate live catalogs for all three harnesses. Pi returns its configured Sonnet model. Codex returns seven visible host models with their exact effort menus, including Ultra only where advertised. Grok Build returns Grok 4.6 with Low through Extra high and Grok 4.5 with Low through High. The deployed UI showed the same menus, changed catalogs when the draft harness changed, and disabled the harness control in an existing Codex Session.

Real initial and resumed Turns completed for Pi, Codex, and Grok Build. Codex Session `44efe059-7055-46f9-ac23-af625cbb6062` kept external conversation `01a0322b-de7e-7083-841a-12bb13160853`; both Turns persisted provider `codex`, model `gpt-5.6-luna`, and requested/effective effort `low`. Grok Build Session `fa6792c1-7444-4cf7-93f1-7961f2e0e38d` preserved its external conversation identity and persisted provider `grok_build`, model `grok-4.5`, and effort `low` on both Turns. Pi Session `93785376-8040-43ff-a5b8-cd629729d5f1` completed both Turns with provider `anthropic`, model `claude-sonnet-4-6`, and effort `low`.

Failure-path requests also passed against the deployed API. Switching the Codex Session to Grok Build returned 409, requesting Extra high on Grok 4.5 returned `effort_unavailable` with 422, and sending a Grok provider under Codex returned `model_unavailable` with 422. A forced stale Codex and Grok catalog returned an explicit 503 instead of falling back to Pi, then recovered after the production service restarted. The service restart also preserved all tested Sessions, Turns, and external conversation identities.

The restored-model label fix was rebuilt and deployed. A real authenticated browser Turn sent through `https://cohub.atou.cc` completed as `CODEX_UI_TUNNEL_OK` and persisted Codex, GPT-5.6 Luna, and Low on the same external conversation. Desktop at 1440x900 and mobile at 390x844 both passed visual inspection with the model menu readable and free of overlap. Ten loopback runs kept the tested model, Turn, and Space requests below 200 milliseconds p95. The public Tunnel remains variable and took 15-20 seconds for some catalog requests, which is why it is accepted only as the temporary route.

All non-Tailscale scope is implemented and verified. The only deferred acceptance is enabling Tailscale Serve, proving a direct peer path from another online tailnet device, verifying automatic fallback from that real private route, and meeting the 1.5-second direct-page p95 target. The goal remains active until that evidence exists.

## 2026-08-24 Tailscale Serve checkpoint

Tailscale Serve is enabled at `https://mac-mini.tail68463a.ts.net` and proxies the loopback private ingress on port 4180. The production client now has that private origin enabled. A system HTTP proxy initially intercepted the tailnet hostname and made Chrome return `ERR_CONNECTION_CLOSED`; adding `100.64.0.0/10` and `*.ts.net` to the Ethernet proxy bypass list fixed the browser path.

Two deployed routing defects were reproduced and fixed before accepting the path. The client health probe could receive `X-Cohub-Local-Node` but could not read it because CORS did not expose the header, so every successful probe was treated as a failure. The route manager also needed to recognize the browser-facing public origin as a local request origin when the runtime API origin differs. Focused route tests, Web typecheck, the production build, and a real browser reload pass after both fixes.

The authenticated browser now sends the Local Space model, startup, file, Session, label, skill, app, and prompt requests to the Tailscale hostname, with no Local Space API requests observed on `cohub.atou.cc`. Ten sequential browser runs returned 200 throughout. Codex models measured 37.2 milliseconds p95, Space startup 53.3 milliseconds p95, and the file tree 44.4 milliseconds p95. Disabling Serve caused the route-aware client to retry a safe GET through `cohub.atou.cc`; the observed fallback completed in 183.3 milliseconds. Serve was restored, and the client returned to the private hostname in 29.3 milliseconds after the probe TTL.

The MacBook Air peer is online again, but two ten-ping path tests from the Mac mini stayed on DERP San Francisco and ended with `direct connection not established`. The first measured 309-792 milliseconds. A fresh STUN discovery did not change the route; the second measured 298-1,461 milliseconds. The peer advertises public and tunnel-interface endpoints, but the current network does not establish UDP peer-to-peer connectivity. Remote-device page p95 and the direct-peer requirement therefore remain unproven, and the goal stays active.
