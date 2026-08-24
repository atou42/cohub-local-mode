# Cohub Local Mode

Local Mode runs Cohub on one Mac while keeping the hosted Cohub account available in the same client. Local Spaces store files, sessions, indexes, credentials, and agent execution under `~/.cohub-local-mode`. Cloud Spaces continue to use the hosted Cohub APIs.

## Prerequisites

- macOS with Docker or Colima
- Node.js 25 and pnpm
- `cohub`, `codex`, `grok`, and `pi` authenticated on the host as needed
- A Cloudflare account, managed domain, Tunnel, and Access policy for public use
- Optional: Tailscale on the Mac and client devices for a faster private route

Do not expose ports 4173, 4174, 4180, 8787, 8788, 9000, 9001, 54329, or 6380 directly. Local Mode binds them to loopback. Cloudflare Tunnel provides the protected public entry, while Tailscale Serve may publish only port 4180 inside the tailnet.

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

The service starts at login, restarts after an unexpected exit, and writes logs under `~/.cohub-local-mode/logs`. The public web port serves compiled immutable assets directly and forwards page rendering to the loopback-only Worker runtime on port 4174. `pnpm local:service:restart` applies environment or code changes after running `pnpm local:build`. `pnpm local:service:uninstall` removes only the service and leaves all Local Mode data unchanged.

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

For an unattended Mac mini, store the remotely managed Tunnel token in the login Keychain under service `Cohub Local Mode Cloudflare Tunnel` and use the Tunnel ID as the Keychain account. Install the persistent connector only after Access is active:

```bash
pnpm local:tunnel:install -- <tunnel-id>
pnpm local:tunnel:status
```

The connector starts at login and restarts after an unexpected exit. Its LaunchAgent contains the Tunnel ID but not the token. `pnpm local:tunnel:restart` restarts the connector, and `pnpm local:tunnel:uninstall` removes only the service while preserving the Keychain token.

## Optional private-first entry

Local Mode includes a loopback ingress on port 4180 that combines the Web, API, realtime, and object routes needed by the client. Publish it only inside the tailnet:

```bash
tailscale serve --bg http://127.0.0.1:4180
```

Then configure the private HTTPS origin and the exact owner identity in `deploy/local-mode/.env`:

```dotenv
PUBLIC_LOCAL_PRIVATE_ORIGIN=https://mac-mini.example.ts.net
COHUB_LOCAL_TAILSCALE_HOST=mac-mini.example.ts.net
COHUB_LOCAL_OWNER_EMAIL=owner@example.com
```

Run `pnpm local:build` and `pnpm local:service:restart` after changing the private origin. The client probes the private node first and uses the Cloudflare hostname when it cannot be reached. Application errors are not hidden by the public route, and writes are never automatically repeated. Leave `PUBLIC_LOCAL_PRIVATE_ORIGIN` empty to use Cloudflare Tunnel only.

Before treating Tailscale as the performance path, run `tailscale ping` from another active tailnet device and confirm that it reports a direct peer address rather than DERP relay traffic.

## Harness behavior

Pi, Codex, and Grok Build are available only when starting a local agent Session. Each harness loads its own model and effort menu. Pi uses Local Mode's Cohub model configuration. Codex and Grok Build read the authenticated host CLI catalogs from `~/.codex/models_cache.json` and `~/.grok/models_cache.json`.

External catalogs fail closed when they are missing, malformed, stale, or advertise unsupported values. They never substitute the Pi catalog or Sonnet. The selected model and effort are sent to the chosen CLI on the first Turn and every resumed Turn, then persisted on the completed Turn. After the first Turn, the Session keeps that harness and rejects attempts to switch it. Codex and Grok Build run in the attached local workspace and keep their external conversation identity for follow-up Turns.
