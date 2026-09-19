# Agent Parameter Preferences Goal Ledger

## Goal

Expose the real model, reasoning, and speed controls supported by Pi, Codex, and Grok Build. Remember valid choices per signed-in user, harness, and model. Keep each Session locked to its original harness, preserve the existing chat and local Space experience, validate the three runtimes, and deploy the verified result to `cohub.atou.cc`.

## Scope

- Codex models expose their catalog-backed reasoning levels and service tiers. Models with the `priority` tier present a Fast control that defaults on until the user saves a choice for that Codex model.
- Grok Build exposes its catalog-backed reasoning efforts. The installed Grok CLI has no separate service tier, so no synthetic Fast control is added.
- Pi continues to expose its catalog-backed models and thinking levels.
- The current user remembers the last model per harness, the reasoning choice per harness and model, and the Codex service-tier choice per model.
- The prompt contract, local relay, API validation, queued turn metadata, and Codex runtime carry the selected service tier without changing Grok or Pi behavior.
- Permissions, tool policy, plan mode, subagents, temperature, and max tokens are out of scope.

## Design Brief

Mode: utility. The model selector remains a dense engineering control surface in Cohub's existing visual language. Model choice stays the primary scan path; thinking and speed appear as compact, model-bound controls on the same row. Fast is shown only when the selected Codex model declares it, and the composer summary exposes the active choice without adding a separate panel. Interactions update immediately, remain keyboard and touch accessible, and do not move the surrounding composer layout.

## Confirmed Facts

- The installed Codex catalog declares `priority` as a Fast service tier with the description `1.5x speed, increased usage` on GPT-5.6-Sol, GPT-5.6-Terra, GPT-5.6-Luna, GPT-5.5, and GPT-5.4. GPT-5.4-Mini and GPT-5.3-Codex-Spark do not declare a service tier.
- Codex app-server accepts `serviceTier` on thread start, thread resume, and turn start. The current Cohub runtime does not send it.
- Grok Build 1.0.5 exposes model and reasoning effort only. Its Low effort is described as a quick, fast implementation; there is no independent Fast service tier.
- Pi's current agent prompt contract exposes model and thinking level. Temperature and max tokens belong to a different completion API.
- The existing draft preference stores only one model per user and silently removes malformed data. It cannot represent harness-specific or model-specific settings and does not meet this goal.

## Current Status

- Investigation complete for current catalog schemas, prompt path, local relay path, API validation, external harness dispatch, Codex app-server runtime, Grok ACP runtime, model selector, composer summary, and existing browser storage.
- The catalog, public and internal prompt APIs, queue metadata, agent dispatch, Codex app-server runtime, and CLI fallback now carry the real service-tier selection. Unsupported harness and model combinations fail explicitly.
- The model selector now exposes per-model thinking choices for Pi, Codex, and Grok Build, plus Fast only for Codex models that advertise the priority tier. Fast defaults on, Standard is represented explicitly, and the composer shows the active speed.
- A strict signed-in-user preference record now remembers the last model per harness and parameters per harness and model. Legacy model choices migrate forward. Stale choices are repaired with a visible notice; malformed records remain intact until the user explicitly resets them.
- Implementation, deployment, and public acceptance are complete.

## Completion Audit

- Pi, Codex, and Grok Build expose only catalog-backed model and thinking choices.
- Fast is a real Codex service tier, defaults on only for eligible models, remains adjustable after Session creation, and is absent from Grok Build, Pi, and no-Fast Codex models.
- Last model, thinking, and speed selections persist at the required user, harness, and model scopes.
- Stale and malformed preferences follow the required visible repair and explicit-reset behavior.
- Prompt metadata, relay transport, validation, queueing, runtime execution, completed-turn records, intermediate output, error visibility, local Space routing, and mobile layout all remain operational.
- The deployed public client and local Mac mini host pass the agreed normal and failure-path checks.

## Validation Evidence

- API catalog and local-mode route tests pass: 7 tests.
- External harness reducer and command tests pass: 14 tests.
- Core prompt metadata tests pass: 4 tests.
- Web catalog, preference, and thinking-selection tests pass: 15 tests, including explicit Fast, explicit Standard, a no-Fast Codex model, stale settings, malformed storage, and user/harness/model isolation.
- Web Svelte and TypeScript checks pass with 0 errors and 0 warnings.
- SDK TypeScript checks pass. The production Web build completes successfully.
- Local Mode infrastructure, API, gateway, web, private ingress, relay node, and persistent Cloudflare Tunnel are healthy after the host restart.
- Cloudflare Worker `cohub-local-web` is deployed as version `4ef186a9-821c-467a-b08d-c146192af2c5`.
- Public Codex Fast request sent `gpt-5.6-sol`, `high`, and `serviceTier: priority`; it completed with `CODEX_FAST_OK` in 7.6 seconds.
- The same locked Codex Session accepted a parameter-only switch to Standard, sent an explicit null service tier, and completed with `CODEX_STANDARD_OK.` in 2.3 seconds. Fast was restored afterward.
- Public Grok Build request sent `grok-4.6` and `low` with no service tier; it completed with `GROK_PARAM_OK` in 10 seconds and did not return HTTP 422.
- Public Pi request sent `claude-sonnet-4-6` and `high`; it completed with `PI_PARAM_OK` in 6.5 seconds.
- The persisted new-chat selections survive navigation and reload independently: Pi High, Grok Build Low, and Codex High with Fast.
- Database evidence confirms all four acceptance turns completed and preserves the Codex service-tier distinction as JSON string `priority` versus explicit JSON null.
- Authenticated desktop 1440x900 and mobile 390x844 screenshots show the deployed selector, Fast only on eligible Codex models, no horizontal overflow, and no clipped or overlapping controls.

## Adversarial Probes

Automated coverage includes a Codex model without Fast, stale thinking and speed values, malformed storage that is not silently overwritten, a synthetic Grok Fast request, and Fast sent to a Codex model that does not support it. Public runtime and responsive UI probes passed. The standard deliver-gate script could not start because its local Playwright dependency is absent; the authenticated shared-browser CDP run supplied stronger public, interactive, desktop, and mobile evidence instead.

## Blockers

None.

## Next Action

None. The goal is ready to close.
