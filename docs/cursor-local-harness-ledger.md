# Cursor Local Harness Ledger

## Objective

Expose the locally authenticated Cursor Agent as a first-class Local Mode harness without moving workspace data or Cursor credentials to Cohub cloud. Preserve the existing Pi, Codex, and Grok Build behavior, Session harness locking, model preferences, Cloud Space access, generation relay, and live intermediate output.

## Scope

Use Cursor CLI ACP (`agent acp`) over newline-delimited JSON-RPC. Add the `cursor` harness across protocol, API, SDK, Local Mode catalog/capability discovery, agent runtime, and desktop/mobile composer surfaces. Support real model selection, Cursor modes, permissions, session resume, cancellation, `/goal`, rules, skills, and structured runtime events. Cursor Cloud Agents, editor UI, and changes to global Cursor configuration are out of scope.

## Confirmed Facts

- The host has `agent` and `cursor-agent` version `2026.08.11-e8db854` installed at `~/.local/bin`.
- The host Cursor CLI is authenticated independently from the Cohub account.
- `agent acp` returns `initialize`, `authenticate(cursor_login)`, `session/new`, `session/prompt`, `session/update`, `session/request_permission`, and `session/cancel` using JSON-RPC over stdio.
- `session/new` returns available models and modes. Current model IDs are parameterized strings such as `gpt-5.6-sol[context=272k,reasoning=medium,fast=false]`.
- `session/update` emits `session_info_update`, `available_commands_update`, and `agent_message_chunk` in a simple prompt probe.
- Official Cursor ACP docs describe blocking `cursor/ask_question` and `cursor/create_plan`, plus notification events `cursor/update_todos`, `cursor/task`, and `cursor/generate_image`.

## Decisions

- Prefer ACP over one-shot print mode so a Cohub Session can reuse a warm Cursor process and receive live events.
- Keep raw Cursor model IDs as the execution truth. Only expose separate effort, context, fast, or mode controls when ACP advertises them for the selected model; never infer unsupported controls from display names.
- Use the existing host-authenticated process environment. Never copy Cursor tokens into task payloads, database rows, browser storage, logs, or process arguments.
- Treat Cursor blocking extension requests as first-class user-visible states. They must never be ignored or left hanging.

## Validation Evidence

- `pnpm --filter @cohub/protocol test` passed (73 tests).
- Cursor API catalog discovery returned executable ACP model IDs, including `gpt-5.5[context=272k,reasoning=medium,fast=false]`; the invalid `default[]` Auto sentinel is intentionally filtered because Cursor rejects it in `session/set_config_option`.
- Cursor capability discovery is cached and returns `/goal`, `/loop`, `/create-plan`, `/create-rule`, and `/create-skill` without an ACP startup round-trip.
- After `pnpm local:service:restart`, a real local Space completed `CURSOR_LOCAL_OK` and a second prompt in the same Cohub Session completed `CURSOR_FOLLOWUP_OK`; both turns were persisted with provider `cursor`.
- After a second service restart, the persisted external Cursor session was loaded and completed `CURSOR_AFTER_RESTART_OK`, confirming resume across the Local Mode process boundary.
- After the final service restart, the same persisted session completed `CURSOR_FINAL_OK` with the host-rules/skills prompt context enabled.
- An invalid Cursor model was rejected before scheduling with HTTP 422 `model_unavailable`.
- A read-only tool-call probe persisted preparation, sandbox connection, runtime-ready timing, session info, thought chunks, assistant commentary, tool start/update/result, completion, and final assistant text in stream order.
- Focused API and agent Cursor tests passed; Biome check passed on all changed implementation files.
- Full API/agent/web builds remain blocked by pre-existing missing workspace packages and Vite environment exports unrelated to Cursor.

## Blockers

None confirmed. The current Cursor account and CLI are available on the host.

## Next Action

Keep the uncommitted change set scoped to Cursor, finish the final review of local rules/skills visibility and desktop/mobile selection behavior, then commit locally. Remote push remains out of scope until explicitly authorized.
