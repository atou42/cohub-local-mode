---
date: 2026-10-12
topic: workbuddy-local
status: implemented-awaiting-live-acceptance
---

# Cohub Local 接入 WorkBuddy

## 目标

让 WorkBuddy 成为 Cohub Local 可选择的本地工具：查看和同步指定项目的会话，发送任务、查看执行过程、停止任务和继续对话。用户已选择完整接入。

功能已在独立分支实现，尚未发布或部署。调查未上传用户历史、未发起模型请求，也未修改 WorkBuddy 设置。验证情况见 [验收记录](../workbuddy-local-validation.md)。

## 已确认的事实

- Cohub 最新已检查主线为 `4d30d49`，目前只支持 Pi、Codex。实现工作目录独立于原来的会话同步修复分支。
- 本机安装 WorkBuddy 5.1.3，内置 CodeBuddy CLI 2.103.3，入口为 `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/dist/codebuddy.js`。
- WorkBuddy 桌面使用内置 CLI，并设置 `CODEBUDDY_CONFIG_DIR=~/.workbuddy`。其产品配置、登录环境和模型路由不能用独立 CodeBuddy 的默认配置替代。
- 本地 `workbuddy.db` 存储会话元数据；`projects/<目录编码>/<会话 ID>.jsonl` 存储消息。只检查了字段结构和类型，没有导出对话正文。
- 原生记录包括 `message`、`reasoning`、`function_call`、`function_call_result`、`ai-title` 和文件快照；消息正文在顶层，不能套用 Claude 的历史解析器。
- 图片可能是 `image_blob_ref`，需要显式处理本地附件，不能仅上传 JSONL 后声称会话完整。
- 桌面通过内置 CLI 的 `--serve` 和 `/api/v1/acp` 使用 `session/load`、`session/resume` 等操作。
- WorkBuddy sidecar 可列出本机存活会话和其 ACP 地址；其方法为 `session.create/reconnect/resize/kill/list/capture` 和 `sidecar.ping/shutdown`，没有直接发送消息的业务方法。

## 决定接入范围的限制

内置 CLI 的 `AcpView.render()` 会把 `session.meta.acpConnectionId` 设置为当前连接。新客户端加载桌面已有会话可能改变事件归属。因此，仅证明存在 ACP 和 resume 接口，不足以证明 Cohub 可以与桌面安全地共同控制同一会话。

sidecar 列表没有可靠的 busy/idle 字段。桌面的业务 `/rpc` 使用随机凭据，尚未发现公开、稳定的外部接入方式。不能自行抓取私有凭据或修改桌面内部状态来完成共享控制。

**已打开但暂时空闲的桌面会话，也不应直接视作可接管。** 第一版若采用占用检测，需要拒绝所有仍由桌面进程持有的会话。检测失败或返回损坏数据时也必须拒绝续接，不能当作无人占用。

## 方案选择

### A. 同步历史，续接不被桌面占用的会话（建议首版）

使用 WorkBuddy 自带的执行程序与相同产品环境。按目录和用户授权同步历史；在 Cohub 中新建任务；仅继续确认没有桌面进程持有的会话。桌面仍持有会话时明确提示先关闭该会话。

采用此方案：无模型启动、模型目录和历史回放已经通过真实程序验证。续接始终复制到新身份，原文件不变，因此占用检查与执行间即使发生竞争，也不会共同写入原文件。此方案不提供桌面和 Cohub 同时控制。

### B. 桌面与 Cohub 同时使用同一会话

需要确认 WorkBuddy 支持不改变桌面事件归属的共享连接，或由 WorkBuddy 提供外部业务入口。在这个前提没有满足前，不能以直接连接 ACP 冒充完整支持。

### C. 仅历史与实时只读同步

不控制 WorkBuddy 会话。范围最小，但不能从 Cohub 发送任务或继续对话。

## 实施范围

1. 为 WorkBuddy 建立独立的工具标识、模型与在线能力。同步更新服务端校验、SDK、命令行和网页显示，旧版本不应误显示可用。
2. 为发现、执行、停止、事件转换、会话解析和附件建立专门适配层。避免所有现有“非 Pi 就是 Codex”的分支误接 WorkBuddy。
3. 为消息建立稳定关联，区分 Cohub 发起和 WorkBuddy 桌面发起的内容，重连及回流不得重复创建会话或消息。
4. 如支持归档、恢复和跨工具转接，必须验证原生文件格式及附件完整性；无法恢复要明确报错，保留原件，不用空历史或换会话掩盖失败。
5. 沿用 Cohub 原有目录授权和历史导入边界，不自动同步整个用户目录。

主要位置：`packages/protocol/src/runtime/`、`packages/cli/src/runtime/`、`packages/core/src/sessions/prompt.ts`、API 输入校验、SDK 类型以及网页会话选择和运行状态组件。

## 验收条件

- 同一任务能正确显示文本、工具过程、附件、结束状态和失败原因。
- 登录失效、损坏记录、缺少附件和连接中断不会被伪装成成功。
- 历史导入及断线恢复不重复；来自 Cohub 的消息回流不新增副本。
- 停止只作用于目标任务，不影响用户桌面其他会话。
- 被桌面持有的会话不会被接管；续接竞争不会造成两个进程同时写入。
- 必须先验证测试能抓住关键失败，再修改实现。模拟验证与真实 WorkBuddy 验收分开记录。
- 当前没有执行真实新建任务、续接、停止或跨端同步验收。

## 参考

- 本机 WorkBuddy 应用包与内置 CLI，是本机版本行为的主要依据。
- 官方 ACP 文档：<https://www.codebuddy.cn/docs/cli/acp>
- 官方非交互文档：<https://www.codebuddy.cn/docs/cli/headless>

官方当前版本可能比本机内置版本新，不能直接用新文档代替本机兼容性验证。

## 采用的边界

完整接入覆盖历史、同步和从 Cohub 继续对话；在 Cohub 内保持同一会话。桌面与 Cohub 不共同控制同一个打开的 WorkBuddy 会话，Cohub 的副本也不保证自动出现在桌面列表中。真实账号的新任务、续接、停止及跨设备同步尚待验收。
