# Local Network Performance Ledger

## Objective

让 Local Mode 在公网 Tunnel、普通网络和短暂断网时优先使用可信缓存，模型与 Agent 能力选择不被网络延迟卡住，同时保持实时会话和本地数据的实时性与隔离。

## Scope

本轮覆盖本地模型目录、模型可用性、Agent 能力目录、前端请求去重与缓存恢复、Cursor 模型过滤、Thinking Effort 展示和公网部署验证。实时消息流、认证状态、本地文件内容和生成中的状态不进入缓存。

## Confirmed Facts

- Cursor ACP 的 `session/new` 会返回完整模型目录，当前启动探测包含 30 多个模型，且一次探测需要启动并认证一个 `agent acp` 子进程。
- Cursor ACP 当前只为 `grok-4.6` 和 `claude-fable-5` 返回默认的高 effort 模型标识；Cursor CLI 自己的 `agent models` 则列出完整变体。ACP 会拒绝在会话中自行拼接的低/中/高外模型 ID，因此 effort 必须在 ACP 进程启动时固定。
- 旧的 Cloudflare Worker 路由曾截走 `cohub.atou.cc` 的静态资源；已移除冲突路由，公网现在命中 Mac mini Tunnel。

## Decisions

- Cursor 模型目录只允许 `grok-4.6` 和 `claude-fable-5`，前后端同时过滤，服务端仍以完整 ACP model id 为执行真相。
- 前端模型目录使用按用户、来源和 Agent 隔离的 localStorage 缓存，先显示上次成功结果，再后台刷新并去重请求；缓存版本变更时失效。
- Local API 额外保留 Cursor 目录的磁盘缓存，服务重启或 ACP 暂时不可用时可继续返回未过期结果；超过最长保留时间不伪装成正常数据。
- 模型可用性状态使用本地持久缓存，失败刷新保留上次有效状态。
- Thinking Effort 只展示 Agent 和模型真实声明的选项。Cursor 的目录来自 CLI 真实变体，执行通过启动时固定模型完成；Codex、Grok Build 和 Pi 继续读取各自目录的 effort 能力。
- Cursor 的 effort 目录以本机 `agent models` 的真实变体为准，启动时将用户选择映射为 `cursor-grok-*` 或 `claude-fable-5-thinking-*`，不再依赖 ACP 的默认模型列表；单个运行时按模型和 effort 隔离，避免热进程沿用错误变体。

## Changes

- `apps/api/src/local-mode/harness-catalog.ts` 增加 Cursor allowlist、磁盘缓存、TTL、最长保留时间、原子写入和后台刷新。
- Local API 在启动后异步预热 Cursor 目录，避免首次打开选择器承担 ACP 启动成本；预热不阻塞 HTTP listener。
- `apps/web/src/lib/stores/models-catalog-cache-core.ts` 与包装层增加按来源和 Agent 的持久模型目录缓存。
- `apps/web/src/lib/stores/models-catalog.svelte.ts` 改为缓存优先、后台刷新、请求去重，并在前端再次限制 Cursor 模型。
- `apps/web/src/lib/stores/models-status-cache.ts` 与 `models-status.svelte.ts` 增加模型状态缓存。
- `apps/web/src/lib/components/ModelSelector.svelte` 对 Cursor 的真实单一 effort 显示 Thinking 控件。
- Cursor ACP runtime 按模型与 effort 生成启动参数并把选择纳入运行时 key，使用 Cursor 官方支持的启动时模型固定路径。

## Validation Evidence

- API harness catalog tests passed: 143 tests.
- Web focused tests passed: 349 tests, including model catalog and status cache tests.
- Biome check passed for all changed files.
- Cursor ACP probe confirmed `session/set_config_option` rejects `grok-4.6[effort=low,fast=true]`; only the advertised exact model id is executable.
- `pnpm local:build` completed successfully and `pnpm local:service:restart` returned the Local Mode service to ready state.
- After restart, the first authenticated Cursor catalog request took about 11.5 seconds and returned exactly two models; the next request took about 0.2 seconds from the API disk cache.
- The deployed public Tunnel returned HTTP 200 for the authenticated Cursor catalog after the service restart. Two consecutive public requests completed in about 0.17 seconds each and returned exactly `grok-4.6[effort=high,fast=true]` and `claude-fable-5[thinking=true,context=300k,effort=high]`.
- A real browser page wrote the local model cache and, after selecting Cursor, displayed only `grok-4.6` and `claude-fable-5`; both showed the true ACP-declared `High` effort control.
- The browser resource trace showed the cached second Cursor request at about 0.19 seconds and the direct local-node request at about 0.02 seconds.
- A corrupted browser cache entry was rejected and repaired by a live response; the Cursor picker still showed the two valid models. During a short browser disconnect, the already-loaded picker continued showing the cached catalog without a network request.
- Desktop and mobile browser checks confirmed the Cursor picker layout stays usable and the other harnesses retain their real effort menus: Codex exposes its multi-level menu, Grok Build exposes Low/High, and Pi exposes its configured options.

## Open Checks

- Full web typecheck remains blocked by pre-existing missing `$env/static/public` exports (`PUBLIC_API_ORIGIN`, `PUBLIC_GATEWAY_ORIGIN`, and `PUBLIC_COHUB_ENV`) in unrelated files; the changed cache modules introduce no typecheck errors.
- A full cold offline page reload cannot be supported because the application shell itself is not available without a prior load; the accepted short-disconnect behavior is covered by the warm-cache check above.

## Next Action

保留当前缓存策略并在后续上游同步时复核缓存契约；不要把实时消息流、认证或本地文件内容放入这套缓存。
