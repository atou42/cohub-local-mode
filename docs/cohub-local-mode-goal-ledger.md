# Cohub Local Mode Goal Ledger

## Objective

Build and validate a fork-only Cohub Local Mode for a Mac mini. Reuse the existing Cohub interface, show local Spaces in a dedicated section of the existing Space switcher, keep cloud Spaces connected through the hosted Cohub account, and support Pi, Codex, and Grok Build with one immutable harness choice per started Session.

## Scope Boundary

- Work only in `atou42/cohub-local-mode`; do not open a pull request against `talesofai/cohub`.
- Preserve the current Cohub web experience and cloud Space behavior.
- Keep local files, session state, indexes, credentials, and execution on the Mac mini.
- Use Cloudflare Tunnel and Access for the first public entry point; do not build a custom relay or multi-node network in this goal.
- Do not parse human-oriented Cohub CLI output as the long-term cloud data plane.

## Confirmed Facts

- The fork exists at `https://github.com/atou42/cohub-local-mode` and is cloned in this directory.
- The source baseline is Cohub commit `282000a1`.
- Production self-hosting expects Web, API, Worker, Agent, Sandbox, Gateway, Postgres, Redis, Git storage, object storage, and OIDC; Local Mode must avoid reproducing that full topology when it is not required.
- Cohub already uses Pi as its native runtime.
- Grok Build exposes headless machine-readable output and ACP.

## Current Status

- Local Mode is implemented only in `atou42/cohub-local-mode`; no upstream pull request has been opened.
- The Mac mini runtime starts Postgres, Redis, MinIO, API, Worker, Agent, Gateway, and Web with loopback-only ports and persistent data under `~/.cohub-local-mode`.
- One Cohub client now merges local and hosted Spaces, labels their origin, and routes Space-scoped reads and writes to the correct API.
- Local Sessions support Pi, Codex, and Grok Build. The selected harness is persisted, inherited by forks, retained across follow-up Turns, and rejected with HTTP 409 when a caller attempts to switch it.
- Codex and Grok Build use argv-safe local sandbox process execution, retain their external conversation identity, preserve tool activity in the Cohub timeline, support abort, and fail on invalid or oversized machine output.
- The Mac is authenticated to Cloudflare, the remotely managed `cohub-local-macmini` Tunnel exists, and proxied DNS for `cohub.atou.cc` points to it. The tunnel secret is stored in the macOS Keychain rather than the repository.
- The remaining public deployment gate is Cloudflare Zero Trust plan activation. The Free plan costs $0, but its checkout asks the account owner to authorize charges if usage exceeds the free allowance, so activation is intentionally waiting for explicit owner consent.

## Safety Gate

The repository contains package lifecycle hooks, CLI self-update behavior, network clients, child-process execution, and deployment scripts. Initial dependency installation must ignore lifecycle scripts. Release, deployment, global installation, sandbox rollout, and self-updating CLI commands remain blocked until their exact entry points are intentionally reviewed.

VERDICT: LIMITED_EXEC_OK

Allowed commands: read-only Git and source inspection; `pnpm install --ignore-scripts`; targeted package tests, lint, typecheck, and build after installation; local development services only after their configuration and startup scripts are reviewed.

Blocked commands: release, deploy, rollout, global package installation, production credentials, production API mutation, unreviewed Docker/Kubernetes startup, and Cohub CLI self-update.

## Validation Evidence

- `repo_safety_scan.sh` inspected manifests, lifecycle hooks, subprocesses, network access, global installs, environment reads, and self-update behavior on 2026-08-24.
- `pnpm install --ignore-scripts --frozen-lockfile` completed without running lifecycle hooks.
- Migration 0064 applied successfully to the live local database and object-store initialization created both required buckets.
- `pnpm local:status` reports Postgres, Redis, object storage, API, Gateway, and Web ready.
- `pnpm local:host` builds the production web client and serves the compiled Cloudflare Worker locally with all four Local Mode public bindings present.
- Protocol build and 79 tests pass. Focused Local Mode tests pass for harness validation and locking, Cloudflare Access entry checks, local Git corruption handling, Space-origin routing, and external harness event reduction.
- Web typecheck passes with zero errors and warnings. Lint passes across all changed source files. The Agent package typecheck reaches only pre-existing missing private `@talesofai-billing/sdk` imports; the running Agent and focused harness tests pass.
- Real Pi, Codex, and Grok Build Turns completed on the Mac mini. Codex and Grok Build follow-up Turns reused their recorded external identities. A real Codex command produced one tool step and one final message, and the Turn finalized as completed.
- A real API attempt to switch an existing Codex Session to Grok Build returned HTTP 409.
- Desktop and mobile browser checks show Local and Cloud groups in the existing Space switcher, all three harness choices for a new local Session, a locked harness on started Sessions, and the real Codex tool timeline. Local task traffic was captured against the local API rather than the hosted API.
- `cloudflared tunnel --config deploy/local-mode/cloudflared.example.yml ingress validate` passes.
- Cloudflare accepted the remote ingress configuration for browser, API, realtime, session objects, and assets. The `cohub.atou.cc` DNS route is active but the tunnel is not started before Access protection is enabled.

## Open Work

- With explicit owner consent, activate Cloudflare Zero Trust Free, add the owner-only Access policy, start the tunnel, and run the final public desktop/mobile acceptance check.

## Next Action

Obtain consent for the Cloudflare Zero Trust Free checkout authorization, then validate the real protected public URL. No code change is currently required for that step.
