# Space wallet

Space wallets fund Cohub usage independently of Space Commerce. This integration adds **no Cohub database tables, columns, or migrations**. Billing remains the source of truth for customers, orders, balances, and usage transactions.

## Behavior

- Signed-in users with `space.view` can recharge; contributing grants no additional access.
- The customer identity is deterministically `cohub:space-wallet:<spaceId>`. Customers are created only when starting recharge, not while browsing balances or charging unrelated personal usage.
- At settlement, actual usage cost is checked against the Space balance and consume preview. If sufficient, Space pays the whole charge; otherwise the original user pays the whole charge. No split payments.
- Personal entitlements and model discounts are unchanged. Personal balance transfers and withdrawals are not supported.
- When the wallet business is unconfigured, usage follows the original personal billing path with no wallet lookups or additional database reads/writes. The wallet UI remains visible with an unavailable recharge message.

## Configuration

Set `TALESOFAI_BILLING_SPACE_WALLET_BUSINESS_KEY` identically on API, agent, task worker, and system worker. It shares the existing provider URL and Admin key, but must differ from `TALESOFAI_BILLING_BUSINESS_KEY`. Missing/same-business configuration disables wallet operations without disabling personal billing.

The agent only receives the wallet business key to stamp new-message eligibility; it needs no billing Admin credentials. The deployment template injects this optional key explicitly. API and workers retain the full billing connection configuration.

Provision one shared business for all Space wallets, not one per Space. Recommended key: `cohub_space_wallet`; display name: **Cohub Space Wallet**.

- No default plan or automatic enrollment. Keep the personal business's default plan unchanged.
- Create public, active, one-time recharge products with `meta.appName = "cohub"`.
- Bind business-scoped, purchased `usd_micro_cent` Benefits. Set `meta.display.credit_benefit_keys` to the actual bound Benefit keys for the existing catalog adapter. Reuse commercial specifications, not Product rows across businesses.
- Verify payment routing, callbacks, refunds, and any business-scoped webhook subscriptions separately for this business.
- Keep wallet identities out of personal referrals, subscriptions, redemption and global grant workflows.

The provider can consume global grants as well as current-business grants. Wallet use requires reported global availability of zero and no currently usable non-purchased grants. Missing global information is unsupported, not assumed zero. The same validation runs before checkout and payer selection. It uses the existing balance query; Cohub never revokes default grants to make a wallet usable.

Do not rename or switch a funded wallet business as a configuration-only migration. Without a local mapping, the configured business is authoritative; another key points at another ledger, not a transfer of old funds. Keep all service instances consistent. Drain billing work and investigate ambiguous debits before enabling, disabling, or switching this configuration.

## Charging and retries

`packages/core/src/space-wallet` contains the shared API/worker route. It stores no payer selection or charge result. Usage keeps existing `source_id`, `operation_id`, `usage_type`, and provider idempotency keys. Billing transactions link usage to credit grants, and grants link back to recharge orders. Space-funded charges prefix `reason` with `actor_user_id=<encodeURIComponent(original user ID)>; `, followed by the original description within the provider's 1,024-character limit. Personal charges are unchanged. This records the actor without a new billing field; the wallet UI does not yet parse or display it, and historical entries are not backfilled.

Preview errors may fall back to personal billing **before a debit is attempted**. Once either payer's debit is issued with wallet routing enabled, failure/timeout is logged with operation, source, payer, business and amount; it returns skipped, never immediately debits the other account or schedules a rerouted billing retry.

API/agent stamp a `walletBillingEligible` boolean on new messages using configuration at creation; old messages and messages created before enablement retain personal routing, including incomplete historical processing. Already aggregated messages are not billed again. Session postprocessing atomically sets one `walletBillingAttempted` flag in the existing message Meta before attempting wallet-enabled billing. It records no payer, amount, or result; duplicate new jobs and crash recovery cannot claim it twice. A crash after claiming may leave usage uncharged. The flag is honored even if wallet configuration is subsequently disabled.

Wallet-enabled generation retries (including stalled recovery, detected through BullMQ `attemptsStarted`) and explicit billing retry jobs skip charging instead of selecting a new payer. Personal retries remain unchanged when wallet routing is disabled. This intentionally accepts potentially uncollected usage and manual investigation in exchange for not introducing durable routing state or a recovery subsystem. Re-enqueuing an operation as a fresh job, replaying it outside these guarded retry paths, or changing configuration across attempts is **not** protected by a durable payer decision. Operators must not blindly replay ambiguous charges.

Local preview/debit pairs are serialized per Space, but cross-process concurrency, expiry or refunds can still cause wallet overage. Such results are logged and never followed by a second personal debit. Strict no-overage and arbitrary cross-account replay safety require future provider support.

Empty balances have a bounded five-second process cache. Positive balances are refreshed before selection. Recharge confirmation clears the local negative cache; other instances converge within five seconds. No new table or local billing ledger is introduced. Only wallet-enabled message attempts update the existing message Meta flag.

## Orders, activity and UI

Recharge passes the contributor, Space, and request UUID in billing order `meta`, with a stable provider idempotency key. Confirmation queries billing orders by business, customer and those Meta fields, then validates their ownership. There is no local order mapping. A missing order is not treated as settled; retry checkout creation with the same request UUID after an interrupted response.

Activity uses provider-paginated raw credit transactions: each page fetches only that provider page, not all history. Consume and historical-overage settlement entries show actual funded debits; unbacked debt is not a balance movement and is not listed separately. One usage operation can appear as several grant-bucket entries with the same operation/source ID. The personal account's grouped activity view is unchanged. Source IDs are preserved. This initial version does not enrich activity with contributor/actor names (`actorUserId` is null); order metadata and existing message/task IDs remain the authoritative audit links. Avoid per-row order/message requests just to render a name.

The page uses user-scoped server-data snapshots and refreshes on focus/visibility and every 30 seconds while visible. URL outcome parameters never establish payment success. No realtime event or webhook consumer is added in this version.

## API / SDK / CLI

All routes under `/api/spaces/:id/wallet` require authentication and Space visibility:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Balance and usability |
| GET | `/catalog` | Supported recharge products |
| GET | `/activities?page=1` | Provider ledger activity |
| POST | `/orders` | `{ id: UUID, productKey }`; reuse `id` on retries |
| GET | `/orders/:orderId` | Confirmation by contributor's request UUID |

```ts
const wallet = client.space(spaceId).wallet;
await wallet.get();
await wallet.catalog();
await wallet.activities(1);
const { checkout, orderId } = await wallet.createOrder({ id: crypto.randomUUID(), productKey });
// Open checkout.checkoutUrl; orderId is the original request UUID.
await wallet.confirmOrder(orderId);
```

```bash
cohub -s SPACE spaces wallet balance
cohub -s SPACE spaces wallet catalog
cohub -s SPACE spaces wallet recharge PRODUCT --request-id UUID
cohub -s SPACE spaces wallet confirm REQUEST_UUID
cohub -s SPACE spaces wallet activity --page 1 --json
```

## Verification

No wallet database migration is required. The two never-deployed prototype migrations and all three prototype tables were removed before release; no shared database or financial records were changed.

Focused regression tests retain whole-charge routing, disabled personal paths, no fallback after an ambiguous debit, and atomic message replay protection. Authorized live payment and refund verification remain deployment acceptance tasks.
