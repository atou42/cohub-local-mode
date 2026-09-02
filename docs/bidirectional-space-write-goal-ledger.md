# Bidirectional Space Write Goal Ledger

## Goal

Allow an authenticated owner to mutate an explicitly mentioned Cloud Space from a Local Space and an explicitly mentioned Local Space from a Cloud Space. Keep Local workspace data on the Mac, preserve upstream compatibility, enforce the target Space's real permissions, and expose transport, identity, permission, and availability failures accurately.

## Scope

The implementation is limited to the local fork, the Local Mode API and agent runtime, the existing Cloudflare relay, and the local web client. It does not modify the hosted Cohub service, replicate Local workspace data to the cloud, grant access to unmentioned Spaces, or publish or deploy without separate authorization.

## Confirmed Facts

- Local Space `d5bb1cb3-2154-4037-944f-554e83200df5` Session `f4e318f6-4d45-4e6d-8b10-6417b9f117cd` reproduced the failure against Cloud Space `5cfdff53-424b-483f-b114-c2d4a5e86338`.
- The Local and Cloud accounts have the same user UUID `dec89612d5074605aeeb101a2918379a`. The different `atou` and `ATou` labels are profile-display differences, not separate identities.
- The Cloud account is the `host` of the target Cloud Space and has `file.edit`; direct Cloud CLI reads confirm this.
- The Local API currently proxies only `GET /fs/tree` and `GET /fs/file` for an explicitly mentioned Cloud Space. Mutations fall through to the Local database and are incorrectly reported as `forbidden` or `space not found`.
- The existing Cloudflare relay accepts durable, idempotent commands and connects outward to the Mac, but its command allowlist currently accepts only Local prompt requests.
- Cloud agent tool processes receive `COHUB_EXECUTION_TOKEN`, source Space, Session, Turn, and tool-call identity. Prompt-scoped environment variables can point the Cohub CLI at a federated API without modifying the hosted agent service.

## Decisions

- Local-to-Cloud mutations will reuse the connected Cloud account token, require an actor-bound running turn with an explicit Cloud mention, verify that the Cloud account UUID matches the actor, and let the hosted Cloud API enforce target permissions.
- Cloud-to-Local mutations will use the existing outbound relay. The federated relay endpoint will verify the Cloud execution token and the active turn's explicit Local mention before accepting an allowlisted filesystem request.
- Relay filesystem commands will carry a deterministic idempotency identity derived from the source tool call and exact request. The Local API will receive the same mutation identity so retries reuse the existing sandbox mutation receipt.
- Only list, read, write, mkdir, move, and delete filesystem routes are federated. Member management, access-policy mutation, arbitrary API paths, uploads, and unmentioned targets remain unavailable.

## Current Status

Complete. Relay protocol version 3, the public web client, and the Mac service were released together. Public Local-to-Cloud and Cloud-to-Local write, read, and delete paths passed against real Spaces. Missing-mention and offline-node failures were also verified through the public relay.

## Implemented

- Local-to-Cloud list, read, write, mkdir, move, and delete requests are forwarded only from an actor-bound active Local turn that explicitly mentioned the Cloud target. The connected Cloud account UUID must match the turn actor, and the hosted Cloud API remains authoritative for target permissions.
- Cloud-to-Local filesystem requests use `https://relay-node.atou.cc` as a federated Cohub API only when the cloud prompt explicitly mentions a Local Space. The relay verifies the Cloud execution token against `/api/me`, verifies the source Session and active Turn, requires the exact Local mention, strips the Cloud credential, and enqueues only the allowlisted filesystem request.
- The relay checks node availability before enqueueing, returns `local_node_offline` without a delayed side effect when disconnected, waits for the Local result when connected, and preserves Local HTTP permission and validation responses.
- Filesystem commands use a deterministic UUID derived from source tool-call identity and the exact normalized request. The same UUID is injected as the filesystem `mutationId`; Local Space mutations with a mutation ID reuse the existing sandbox mutation job receipt.
- Relay protocol version 3 prevents an updated Worker and an older node from silently disagreeing about filesystem commands. The release gate already verifies Worker and node protocol equality before declaring a release ready.
- Pi receives Local-node cross-Space CLI instructions. Codex, Grok Build, and Cursor receive explicit Cloud read/write CLI instructions and must expose identity, permission, unsupported-route, and transport errors without inventing read-only access.

## Acceptance Evidence Required

- The original Local-to-Cloud failure becomes a successful write and readback under the same UUID and Cloud `host` role.
- A Cloud turn can write and read back a file in an explicitly mentioned online Local Space through the relay.
- Identity mismatch, missing mention, read-only target role, malformed path, Local node offline, and repeated identical mutations fail or replay with the expected explicit result.
- Existing cross-Space reads, Local prompts, harness execution, message delivery, and upstream-compatible Cloud Space access remain working.

## Validation Evidence

- The original Local-to-Cloud unit reproduction failed before the change because the forwarded request was `GET` instead of `PUT`; the same check now passes.
- A live write through the new Local-to-Cloud proxy created `bidirectional-bridge-acceptance-f4fc2fa6-be7f-4499-aa02-51433429ebb1.txt` in Cloud Space `5cfdff53-424b-483f-b114-c2d4a5e86338`, read back the exact bytes, and deleted it successfully. Write, read, and cleanup all returned HTTP 200.
- A live in-process Cloud-to-Local path used the federated authorization layer, sanitized relay command, updated node executor, and real Local API to create `bidirectional-local-acceptance-7fe11130-9d8d-4631-b253-0d11ab434f23.txt`, read back the exact bytes, and delete it successfully. Write, read, and cleanup all returned HTTP 200.
- Relay Worker tests pass 76 of 76. Relay node tests pass 76 of 76. Focused Local API proxy tests pass 6 of 6. Agent prompt and runtime tests pass 34 of 34. Web federated prompt tests pass 3 of 3. Relay typecheck and Biome checks pass.
- A full Local Mode production web build completed successfully. Existing unrelated build warnings about `PUBLIC_PREVIEW_ORIGIN`, `vconsole` eval, and an ineffective dynamic import remain unchanged.
- Cloudflare Relay dry-run packaging completed successfully with the existing Durable Object, Queue, R2, and the new `CLOUD_API_ORIGIN=https://api.cohub.live` binding. The local Relay source digest is `2f41d44e685d3de13e1b10af2a4dc98344ce7fa93a0a037ace7232ee489916b6`; production still runs the prior `cc586ff219c4650625084fd00a3145ec3fc003d480c5367fdf3cf1543ed860ed` deployment.
- The pre-release rollback points are Relay Worker version `8194ba26-e437-451c-b5e2-7fce2488ef3d` and Web Worker version `e9fced3a-d932-4f98-b9a4-61afeb4595ca`.
- A repeated Local Mode status check reports Postgres, Redis, object storage, API, Gateway, Web, private ingress, and the Cloudflare relay node all ready. The earlier private-ingress timeout was transient and did not recur.
- Repository-wide API typecheck still reports the established missing optional billing SDK and pre-existing harness-catalog errors; no errors remain in the changed proxy, filesystem route, or filesystem backend files.
- Missing Local mention, actor mismatch, arbitrary API path, malformed mention metadata, Local node offline, target permission denial, idempotency mismatch, duplicate request identity, and protocol mismatch are covered by focused failure-path tests.

## Production Acceptance

- The final atomic release deployed Relay Worker version `0dd53b63-25bb-43b1-ae7d-ca8d82579ac1`, Web Worker version `f9b6c9af-bbcb-4163-95ba-164402bb9a17`, web build `1788314044521`, and Relay digest `2153cba2751e2576b61640fa7fbae1ee369bb9e66738bd4d9c713b974d7cb77c`.
- Public Local-to-Cloud acceptance passed from Local Session `dc9ccebb-e8d8-4493-b0c8-07fd4026de7d`: it created and read back `bidirectional-public-local-to-cloud-1788310000.txt` with exact content `LOCAL_TO_CLOUD_PUBLIC_1788310000`, then deleted it. Independent Cloud CLI checks confirmed the readback and cleanup.
- A final-code Local-to-Cloud pass used Local Session `de946323-61ce-4f38-9241-77d803695a22` and `bidirectional-public-final-local-to-cloud-1788314000.txt`. A transient Cloud network failure during deletion was exposed to the user instead of being hidden; one explicit retry succeeded, and an independent Cloud read confirmed the file was absent.
- Public Cloud-to-Local acceptance passed from Cloud Session `0db873fb-7304-4068-8b4e-fc2359f76744`, Turn `eb2af120-a804-452b-bf74-c365a2762d89`: it created and read back `bidirectional-public-cloud-to-local-1788313000.txt` with exact content `CLOUD_TO_LOCAL_PUBLIC_1788313000`, then deleted it in the same Session. Independent Local filesystem checks confirmed both the readback and cleanup.
- The first public Cloud-to-Local attempt exposed a Worker `Illegal invocation` error. A regression test reproduced the incorrect fetch receiver before the fix and passed after it. The hosted Cloud CLI also ignored the injected relay base URL, so the local web client now provides hidden, turn-scoped relay instructions only for explicit Local mentions; these instructions are not rendered in the conversation.
- A Cloud turn without a Local mention returned HTTP 403 `local_space_not_mentioned`. With the Mac service intentionally stopped, an explicitly mentioned Local target returned HTTP 503 `local_node_offline` with no delayed side effect. The service was then restored.
- Final status reports Postgres, Redis, object storage, API, Gateway, Web, private ingress, and the relay node ready. The tunnel is running, and the public authenticated node status reports relay protocol 3 with `connected: true`. No acceptance files remain. The existing APNS configuration health error is unrelated to this goal.
- A post-release client reported a blank screen followed by SvelteKit's default `500 Internal Error` page while clean authenticated loads were already healthy. The release still had three confirmed gaps: private app shells did not carry `private, no-store`, server-level failures had no bounded client recovery page, and Local Mode readiness checked only a static file. These gaps were fixed and released as Relay Worker `79b71153-20ac-464b-8af6-df7dcc9308bb`, Web Worker `c00b81ec-55f9-4f58-a1be-e3eb58425866`, and web build `1788318073161`. The readiness gate now rejects HTTP 500, cacheable app shells, and shells missing the application entrypoint.
- After the recovery release, authenticated desktop and mobile loads of Local Space `d5bb1cb3-2154-4037-944f-554e83200df5` returned HTTP 200 with `cache-control: private, no-store`, rendered the workspace without horizontal overflow, and produced no page or module exception. The existing Cloud apps-catalog request for a Local Space still returns 403 and is unrelated to page startup.

## Completion Verdict

All required public paths and the two highest-risk failure paths passed. The release gate confirmed the public web build and Relay source match the running Mac service, so the goal is complete.
