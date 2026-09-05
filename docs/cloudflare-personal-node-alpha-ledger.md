# Cloudflare Personal Node Alpha Goal Ledger

## Goal

Ship a Cloudflare-only Cohub Personal Node Alpha at `dev-cohub.atou.cc`. A user installs the macOS Electron client, signs in through a dedicated Logto client, and the computer registers as a revocable Personal Node. The same user can control Local Spaces from desktop and mobile browsers without a VPS, Cloudflare Access, Tunnel, DNS, public ports, or terminal setup.

The Alpha must reuse Relay protocol v3, Codex, Pi, Grok Build, Cursor Agent, Local Session registry, explicit attachment relay, Cloud generation, and federated Local/Cloud Space access. Local workspace bytes, native Agent sessions, Skills, AGENTS.md, environment, and credentials remain local. Cloudflare stores only the account and device index, cached UI projections, command and event state, and explicit attachments.

## Scope

The work includes an isolated Cloudflare development control plane, multi-user and multi-device identity, removal of browser Tunnel dependencies for the complete Local Space workflow, a macOS Electron package, and real desktop/mobile acceptance on the development domain.

The work excludes VPS infrastructure, D1, Postgres or Redis in the Cloudflare control plane, Windows, Linux, shared Local Spaces, complete workspace sync, cross-user operations, and multi-region availability.

Remote Git push requires separate user authorization. No Alpha build or test may deploy to, restart, mutate, or reuse the production resources behind `cohub.atou.cc` or `relay-node.atou.cc`.

## Current Baseline

The starting commit is `c46f4a99` on local branch `feat/cloudflare-personal-node-alpha`. The starting worktree was clean and matched `origin/main`.

The existing relay is production-proven but single-owner and single-node. It uses fixed `NODE_ID`, `OWNER_EMAIL`, and `OWNER_USER_ID` settings, Cloudflare Access for browser identity, one `LocalNodeRelay` Durable Object, wakeup and activity Queues, and a private R2 bucket.

Relay protocol v3 already provides durable ordered commands, leases, idempotency, cancellation, event cursors, offline recovery, explicit attachments, and federated Local/Cloud Space filesystem access. Local Session mappings and normalized transcripts exist under `.cohub/local-sessions` for Pi, Codex, Grok Build, and Cursor.

The current public Web still depends on the Mac ingress for parts of Local Space reads. The Alpha is not complete until the Tunnel can be disabled while the full browser workflow remains usable.

## Decisions

The Alpha uses a separate development domain and separate Cloudflare resources. The initial public endpoint is `dev-cohub.atou.cc`; user API, browser events, and Personal Node connections share this host and use distinct authenticated paths.

Logto is the user identity authority. Each Logto user maps to an Account Durable Object. Each registered computer maps to a Node Durable Object. Queues carry wakeups and background delivery only. R2 stores explicit attachments only. The first Alpha does not add D1.

The existing owner-only relay remains unchanged as a compatibility path. Alpha behavior must be additive and opt-in until the development environment passes acceptance.

## Acceptance

A clean macOS install must complete sign-in and device registration without terminal work, and the device must appear within ten seconds. Browser message acceptance must be visible within 500 milliseconds, and a healthy connected node must claim work within one second.

Desktop and mobile browsers must load cached Local Space, Session, model, effort, Slash command, task, and file-tree state from Cloudflare and refresh it through the node without layout-blocking waits. With Tunnel disabled, the user must still restore a Session, send and cancel work, observe every Agent lifecycle event, and retrieve an explicitly returned file.

Offline and reconnect behavior must execute each command once. Event cursors must recover after refresh and network interruption. A revoked device must stop receiving commands or writing events. Different Logto users must not see each other's devices, Spaces, Sessions, commands, events, or attachments.

Registration, listing, and caching must not upload workspace file contents. File bytes may move only for explicit read, upload, download, or Agent-return actions.

## Required Validation

Run focused unit and integration tests, type checks, formatting checks, Electron build checks, and a real macOS install. Exercise authenticated desktop and mobile browsers on `dev-cohub.atou.cc` with the Tunnel disabled.

Adversarial probes must cover a wrong user, forged device ID, invalid and revoked device credentials, repeated message identity, offline enqueue, reconnect during work, corrupt cached projection, unauthorized Space, malformed path, attachment checksum or size failure, and attempted access to production resource names.

The release guard must prove that Alpha deployment configuration cannot target existing production Worker names, routes, Durable Object namespaces, Queues, R2 buckets, or service directories.

## Progress

2026-09-02 to 2026-09-03: Implemented and deployed the isolated Cloudflare Alpha control plane and Web application. Logto identities are mapped to account-scoped Durable Objects; registered macOS devices use locally generated credentials, support idempotent registration, rotation, revocation, and per-account isolation. Browser and node credentials are stripped at their trust boundaries.

Relay protocol v3 now supports account-scoped devices while retaining the production owner-only route. Commands, cancellation, event cursors, offline recovery, cached projections, and explicit attachments operate through dedicated Alpha Durable Objects, Queue, and R2 resources. The release guard rejects every known production Worker, route, namespace, Queue, bucket, directory, and owner-only setting.

The browser no longer needs the Mac ingress or Cloudflare Tunnel. Local API reads and writes route through the Personal Node relay; bounded successful reads produce Cloudflare projections for responsive desktop and mobile rendering. Secret-bearing environment endpoints remain denied and file bytes move only for explicit operations.

Built the macOS Electron Personal Node package with an embedded Postgres, Valkey, object store, Cohub API, Gateway, workers, Agent runtime, sandbox controller, CLI, and relay node. First launch performs device-code sign-in, stores both node credentials and the renewable Cohub session in macOS Keychain, extracts and verifies the bundled runtime, starts services in dependency order, and connects the device without terminal setup.

Codex, Pi, Grok Build, and Cursor Agent use the Local Session registry and expose lifecycle output, cancellation, model options, and harness-specific settings. Cursor returns the two approved Grok and Fable models from a bundled warm catalog while refreshing discovery in the background. Fresh Pi installations expose GPT-5.6 Sol, Terra, Luna and DeepSeek V4 Pro and Flash. Missing provider credentials now fail explicitly instead of sending an environment-variable name as a token.

The dedicated Logto application, Alpha Relay Worker, Alpha Web Worker, Queue, Durable Object namespaces, and R2 bucket are live on `dev-cohub.atou.cc`. Production `cohub.atou.cc` and `relay-node.atou.cc` were not deployed, restarted, or rebound.

## Validation Evidence

The final guarded release passed 107 Relay tests, Relay type checking, Web type checking with zero errors and warnings, Alpha resource isolation checks, and both Worker builds. Focused API tests passed 15 cases covering Personal Node authentication refresh, corrupt Keychain state, local auth routing, model API keys, and model catalog caching. Focused Agent tests passed 35 cases; the full Agent suite passed 99 cases earlier in the same implementation run.

Authenticated browser acceptance passed at 1440 by 900 and 390 by 844. Both views rendered the real Cohub application without a blank page, horizontal overflow, debug console, or layout overlap. Cached model and Local Space reads refresh without blocking the page. The generic visual gate script could not run because Playwright is not installed in the repository, so the same checks were performed against the authenticated shared Chrome session through its browser debugging interface and the captured images were inspected.

Real Relay runs restored a Local Session, streamed all intermediate Codex lifecycle output, returned `ALPHA_FINAL_OK`, wrote and retrieved the requested file, and completed a second session with `SECOND_RUNTIME_OK`. Cancellation ended the active turn as `interrupted` while the Agent process stayed healthy. A real Cursor Agent session returned `CURSOR_ALPHA_OK`.

A clean application profile completed device-code sign-in and automatic device registration on the deployed Web build. Keychain cloud authentication was written without relying on an existing Cohub CLI login; the local authentication endpoint returned 200 and a forced refresh rotated and persisted the access token. The fresh device connected through Cloudflare with no Tunnel or public port. A live cloud-to-node model command was accepted in 128 ms and completed in 668 ms.

The clean profile exposed exactly the approved Cursor models and all five Pi models. Cursor's first catalog request took 1268 ms while background discovery started; warm requests were below 100 ms in the prior live run. The final desktop view rendered at 1440 by 908 with no horizontal overflow or debug console. A deliberately corrupt installed-runtime marker produced the explicit `Installed runtime marker is invalid` state and was not overwritten or treated as a cache miss.

The release image `Cohub-Personal-Node-0.1.0-alpha.1-arm64.dmg` is 261 MB, passes `hdiutil verify`, and passes strict deep code-signature verification. Its SHA-256 is `5dcfcc7f6317deca4e059a8336e0f5474ddedacb3cc4f5afcc230e03318de527`. The embedded runtime is 706762240 bytes with SHA-256 `7fa300572ebd235b3bd9e2f7725c97f5d679ada2c32164587e0e85fdb47d45e2`.

The live Relay deployment is `41d56f73-c777-41b9-9b6a-da941e1fdf92`; the live Web deployment is `c8e7506c-f4b3-4827-857c-4077c2d7e4b2`. `https://dev-cohub.atou.cc/healthz` returns 200 and ready. The production site still responds on its original route and was not mutated.

## Blockers

No code or Cloudflare blocker remains for the ARM64 Alpha. Distribution is ad-hoc signed because this machine has no Apple Developer ID certificate, so a different Mac may require the standard one-time Gatekeeper override. Pi inference requires a valid provider credential; the package deliberately reports that absence instead of disguising it as a model or token failure.

## Next Action

Obtain an Apple Developer ID certificate and notarize the unchanged release artifact before offering a frictionless public download. Provider credential provisioning for Pi remains a separate product decision outside this Alpha goal.
