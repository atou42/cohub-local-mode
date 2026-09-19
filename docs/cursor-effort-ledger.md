# Cursor Effort Ledger

## Objective

让 Local Mode 的 Cursor Agent 模型与 Thinking Effort 选择对齐本机 Cursor CLI 的真实能力，并在 ACP 不支持可靠会话内切换时通过启动参数固定选择。

## Scope

本账本覆盖 Cursor CLI 模型变体发现、API 目录、ACP 启动参数、运行时隔离、前端选择与缓存，以及桌面端、移动端和公网 Tunnel 验收。其他 Agent、云端 relay、本地文件与实时消息协议不在本轮扩展范围内。

## Confirmed Facts

- 本机 Cursor Agent 版本为 `2026.08.11-e8db854`。
- `agent models` 列出了 Grok 4.6 的 low、medium、high、xhigh 变体，以及 Fable 的多档 thinking 变体。
- ACP `session/new` 只返回默认的 high 变体；对未列出的 effort 发送 `session/set_config_option` 会返回 `Invalid model value`。
- Cursor 文档说明 ACP 可靠的模型选择方式是进程启动时使用 `--model`，而不是依赖会话内切换。

## Decisions

- API 只保留 Grok 4.6 与 Fable 5 两个 Cursor 模型，但目录提供 CLI 已验证的 effort 档位。
- 运行时将选择映射为真实 CLI slug，并在启动 ACP 时传入；模型与 effort 纳入运行时隔离键。
- 不在 ACP 未接受的字符串上做静默回退，不伪造成功。

## Completed Changes

- API Cursor 目录缓存版本升级并提供 Grok/Fable 的真实 effort 矩阵。
- Cursor ACP runtime 增加启动时模型映射，跳过不可靠的会话内模型切换。
- 增加模型映射和目录 effort 的定向测试。
- 前端模型目录缓存版本升级，避免旧的 High-only 快照继续生效。

## Validation Evidence

- API 定向测试通过：143 tests。
- Web 模型目录、状态缓存和模型选择定向测试通过：349 tests。
- Agent 外部 harness 定向测试通过：73 tests。
- `agent -p --output-format stream-json --model cursor-grok-4.6-low-fast` 返回 init model `Cursor Grok 4.6 Low Fast`，随后成功返回 `CURSOR_EFFORT_LOW_OK`。
- 公网 Tunnel 的真实浏览器通过共享 Chrome 验证：切换到 Cursor 后可见 Grok 4.6 与 Fable 5，打开思考级别菜单可选 Grok 的 Low、Medium、High、Extra high；选择 Low 后 composer 显示 `思考级别 Low`。
- `pnpm local:build` 成功，服务与 Tunnel 均为 ready。

## Failures And Risks

- ACP 的 `session/new` 目录仍可能只显示默认 high；这不是前端目录的能力来源，必须依赖启动时固定模型。
- 任何启动 slug 被 Cursor 拒绝时，必须让请求失败并记录错误，不能回退到 high 假装执行。

## Next Action

API、Agent 与 Web 验证已完成；服务已重启，公网 Tunnel 的目录、选择和 CLI 启动参数已验证。
