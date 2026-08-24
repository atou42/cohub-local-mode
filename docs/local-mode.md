# Cohub Local Mode

Local Mode runs Cohub on one Mac while keeping the hosted Cohub account available in the same client. Local Spaces store files, sessions, indexes, credentials, and agent execution under `~/.cohub-local-mode`. Cloud Spaces continue to use the hosted Cohub APIs.

## Prerequisites

- macOS with Docker or Colima
- Node.js 25 and pnpm
- `cohub`, `codex`, `grok`, and `pi` authenticated on the host as needed
- A Cloudflare account, managed domain, Tunnel, and Access policy for public use

Do not expose ports 4173, 8787, 8788, 9000, 9001, 54329, or 6380 directly. Local Mode binds them to loopback and expects Cloudflare Tunnel to be the only public ingress.

## Local startup

```bash
pnpm install --ignore-scripts
pnpm local:setup
pnpm local:up
```

In another terminal, attach a workspace to the local Space with the fork CLI source:

```bash
COHUB_API_URL=http://127.0.0.1:8787 \
COHUB_WS_URL=ws://127.0.0.1:8788/ws \
COHUB_WEB_URL=http://127.0.0.1:4173 \
pnpm --filter @neta-art/cohub-cli exec tsx src/index.ts sandbox up /absolute/workspace/path --yes
```

Open `http://127.0.0.1:4173`. `pnpm local:status` checks the complete local service path.

`pnpm local:up` keeps the web client in development mode. For an unattended Mac mini host, use `pnpm local:host`; it builds the client and serves the compiled Cloudflare Worker locally before accepting traffic.

Install the compiled host as a per-user macOS service after its public values are configured:

```bash
pnpm local:service:install
pnpm local:service:status
```

The service starts at login, restarts after an unexpected exit, and writes logs under `~/.cohub-local-mode/logs`. `pnpm local:service:restart` applies environment or code changes after running `pnpm local:build`. `pnpm local:service:uninstall` removes only the service and leaves all Local Mode data unchanged.

## Pi model

The first setup creates `~/.cohub-local-mode/configs/platform/.cohub/models.json`. Configure that file for a Pi-compatible provider and keep its credential in the host environment named by `apiKey`. Codex and Grok Build use their existing host CLI authentication instead.

## Public entry

Create a named Cloudflare Tunnel. It may use the checked-in configuration template with a credentials file or Cloudflare's remotely managed configuration with a tunnel token. Never commit either credential. The single hostname routes browser, API, realtime, and local object traffic through the tunnel.

Before restarting Local Mode, change these values in `deploy/local-mode/.env`, replacing the example hostname:

```dotenv
WEB_ORIGIN=https://cohub.example.com
PUBLIC_API_ORIGIN=https://cohub.example.com
PUBLIC_GATEWAY_ORIGIN=wss://cohub.example.com/ws
TURN_OBJECT_S3_PUBLIC_ENDPOINT=https://cohub.example.com
TURN_OBJECT_CDN_BASE_URL=https://cohub.example.com/cohub-sessions
PUBLIC_ASSET_OSS_PUBLIC_ENDPOINT=https://cohub.example.com
PUBLIC_ASSET_CDN_BASE_URL=https://cohub.example.com/cohub-assets
CHAT_ATTACHMENT_PUBLIC_BASE_URL=https://cohub.example.com/cohub-assets
APP_ASSET_CDN_BASE_URL=https://cohub.example.com/cohub-assets
CHECKPOINT_ASSET_OSS_PUBLIC_ENDPOINT=https://cohub.example.com
```

Restart with `pnpm local:host`. Protect the entire hostname with a Cloudflare Access self-hosted application before starting the tunnel. The policy must admit only the owner because a successful Access request can obtain the host's Cohub account session. The API also rejects a production non-loopback Local Mode auth request when Cloudflare Access has not asserted identity.

## Harness behavior

Pi, Codex, and Grok Build are available only when starting a local agent Session. After the first Turn, the Session keeps that harness and rejects attempts to switch it. Codex and Grok Build run in the attached local workspace and keep their external conversation identity for follow-up Turns.
