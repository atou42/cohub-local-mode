# Cohub 安装版架构审视报告

本文为 2026-09-05 已有文档的审阅副本，保留原时点判断。当前实现与修复状态以 [现状、目标与问题](./Cohub安装版现状、目标与问题.md) 为准。用户于 2026-09-06 新增授权将当前安装版独立分支提交 GitHub，供 ChatGPT Pro 咨询；不包含合并 main、部署生产或更换客户端。历史本地日志与截图未公开，不可作为审阅方已亲自验证的证据。

2026-09-05。基于用户已确认的[审视规格](./Cohub安装版架构审视规格.md)。本次只做审视，没有修改产品代码、安装软件、启动设备、重启服务、提交任务或发布。

## 结论

安装客户端、使用自己的电脑执行任务、无需自己部署 Cloudflare，这个产品方向成立。但当前实现还不能作为面向普通用户的可靠安装版。问题不只是线路质量。已复现一个会丢失执行结果的连接协议缺陷，也查到了普通页面读取在云端等待约半分钟、尚未被电脑领取就被取消的真实记录。

最值得调整的设计是本机使用仍强制经过云端，页面读取和实际操作又共用一条整机串行队列。本来同一台电脑就能完成的交互，被登录、外网、中转、排队和本机启动状态共同限制。建议改为本机客户端直接使用本机服务，云端继续负责账号、设备管理和异地访问。保留后台 Connector，不急着更换 Cloudflare、Electron 或数据库。

严重程度按阻止继续分发、正式发布前必须解决、之后再优化排序。下文明确区分隔离复现、真实历史记录、源码路径和设计判断，不能把它们当成同一种证据。

## 阻止继续分发的问题

### 执行中的确认消息会把任务提前清掉

这是本次已复现的缺陷。云端收到电脑的 started 消息，会返回 status 为 running 的 ack。电脑收到任何同任务 ack 都清除当前任务，没有区分正在执行和已经完成。随后本机请求返回时，因为当前任务已被清除，结果被直接丢弃，心跳也已经停止。

证据是云端 [index.ts:1971](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/local-relay/src/index.ts#L1971)，电脑端 [index.mjs:415](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/local-relay/node/index.mjs#L415)、[清除任务:224](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/local-relay/node/index.mjs#L224) 和[放弃结果:283](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/local-relay/node/index.mjs#L283)。alpha.4 已打包应用中的 relay-node.mjs 第 12935 行仍包含同样分支，不只是尚未发布的源码问题。

隔离实验通过语法树提取当前源码中的原始函数，不修改这些函数，替换网络和本机执行为受控对象。没有 running 确认时能发出 started、result；在本机请求结束前收到正常 running 确认时只发出 started，不再发 result。要求结果必须送出的断言失败，退出码为 1。这是发现产品缺陷的预期结果，不是已修复或产品测试通过。复现脚本（历史本地证据，未随仓库发布：`/Users/atou/agents-in-discord/workspaces/1545762101967196260/.review/ack-probe.mjs`）与结果（历史本地证据，未随仓库发布：`/Users/atou/agents-in-discord/workspaces/1545762101967196260/.review/ack-probe-result.json`）已保留。

用户会看到操作一直等待或超时，而电脑实际已经执行。租约到期后云端还会重新排队；对没有业务去重保证的写操作，这存在重复执行风险。不能以增加重连次数、拉长超时或更换线路代替修复，也不能据此断言此前所有连接问题都由这一处引起。必须先区分执行确认与最终结果确认，并覆盖确认早到、结果晚到、断线重送与重复确认的真实消息顺序。

## 正式发布前必须解决

### 页面请求和用户操作被同一条队列互相阻塞

当前菜单栏客户端打开 dev-cohub.atou.cc，网页将本地接口请求转为云端命令，再等待本机领取和回传。云端只要发现该设备存在 claimed 或 running 命令，就不再分发下一条。电脑端同样只有一个 current。文件目录、会话列表、模型发现等读取，会与创建、编辑、发送操作竞争同一个入口。这里的问题是慢接口拖住整机，并不是每次模型生成都会一直占着队列，发送接口可以提前返回。

路径证据是 [personal-node-fetch.ts:159](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/web/src/lib/personal-node-fetch.ts#L159) 和[整机串行分发:1855](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/local-relay/src/index.ts#L1855)。这套做法便于复用原网页，却把用于可靠提交任务的机制同时用于高频页面交互。它不是 Cloudflare 强制要求的结构。

读取 MacBook 的最近 20 条保留记录，其中 19 条 GET 在北京时间 2026-09-04 08:08:42 起被云端接收，经过 30.6 至 31.5 秒被取消；attempt 全为 0，claimedAt 和 startedAt 均为空。另一条被领取后以 local_api_rejected 结束。它们证明当时请求已经到达云端，但多数没有进入电脑执行，不能归为网页打不开。当前快照不足以区分当时离线、队列阻塞或启动未完成，更不能把这 20 条当作总体失败率。自动超时也调用取消接口，cancelled_by_user 不代表用户手动取消。

旧 Mac mini 的最近 20 条记录中，13 条读取成功、7 条本机接口拒绝，成功耗时从 302 毫秒到 7.4 秒。已有开发记录另记载过数百次并发命令拒绝和慢启动。它们来自不同版本，不能混在一起归因。脱敏现场证据（历史本地证据，未随仓库发布：`/Users/atou/agents-in-discord/workspaces/1545762101967196260/.review/审视证据.json`）保留了范围、时间和分组。

建议本机入口绕开云端命令队列；远程入口让可丢弃、可重新读取的页面请求与必须确认结果的写操作分开。读取需要有界并发与合并刷新，写操作按有实际顺序要求的会话或资源排序，取消不应排在普通刷新之后。无需为此重写整个业务服务。

### 超时没有统一含义，重试不能可靠判断是否已经执行

网页给等待结果设定 30 秒期限，超时后发起取消，却不检查取消是否成功。云端对已领取或正在执行的任务返回冲突，不会停止它。电脑端本机请求的默认期限是 60 秒，而且先获取本机认证，再创建计时器，认证阶段仍不在这个期限内。网页的轮询请求本身也没有绑定终止信号，因此 30 秒不是完整链路的严格上界。

依据是[网页等待与取消:120](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/web/src/lib/personal-node-fetch.ts#L120)、[服务端取消规则:70](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/local-relay/src/lifecycle.ts#L70) 和[认证先于计时:778](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/local-relay/node/core.mjs#L778)。普通接口每次重试又生成新的 [idempotencyKey:74](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/web/src/lib/personal-node-transport-core.ts#L74)。已有特定消息路径的去重能力应保留，但它不能替所有写接口兜底。

需要让排队、认证、本机执行、返回结果共享明确的截止时间；前端必须区分没被接收、正在执行、已经完成、结果暂时未知。对结果未知的写操作，应查询同一次操作的记录，而不是当成失败重新创建。失败原因也应区分认证失败、本机未启动、排队过久与执行失败。上述时间与状态不一致来自源码，未在真实账号上制造重复写入来验证后果。

### 健康检查不能证明连到了正确的本机服务

客户端只要看到 127.0.0.1:8787 的 healthz 返回成功，就认为本机服务准备好了，不再检查是否属于这个安装实例。运行管理器同样提供 ready external 分支。这会接受另一个开发环境、旧版程序或不同数据目录的服务。现有清理代码有进程归属保护，但健康检查提前返回的路径绕过了它。

依据是 [main.ts:826](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/desktop/src/main.ts#L826)、[main.ts:992](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/desktop/src/main.ts#L992) 和 [manager.mjs:529](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/desktop-runtime/manager.mjs#L529)。这是确定存在的接入规则缺口，本次没有实际让客户端接入其他服务。

启动握手应确认安装实例、账号、数据目录标识和兼容版本。端口被别的实例占用时明确报错，不应为了显示可用就接管它。这既影响连接可靠，也影响用户是否看到自己的原有会话和文件。

### 设备选择与连接状态不够可信

网页把上次设备选择存在一个全局浏览器键里。只要那台设备没有被撤销，就持续选择它；没有选择记录时按设备更新时间选一个。它没有表达当前电脑与远程电脑的区别，也没有把本地 Space 的归属明确绑定到设备。本次网页实际选中旧 Mac mini 注册记录，同时账号下还存在 MacBook 注册。由于本次所有设备都离线，不能声称忽略了一台可用设备，但现有选择规则确实没有在线状态或明确的工作区归属依据。[设备选择:38](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/web/src/lib/personal-node-transport-core.ts#L38)。

状态还有另一处确定的缺口。菜单栏程序从子进程输出包含 connected as 的文本判断已连接；子进程内部连接断开、自行重连时，不会把父进程的 relayConnected 改回 false，只有整个子进程退出才会。云端则以保留的连接对象数量表示 connected，保存的 Connector 状态没有按新鲜程度失效。因此连上中转、电脑服务可用、Agent 可执行不能共用一个绿色状态。[父进程状态:1038](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/desktop/src/main.ts#L1038)、[内部重连:449](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/local-relay/node/index.mjs#L449)、[云端状态:524](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/local-relay/src/index.ts#L524)。

建议清楚区分本机和其他电脑，让 Space 归属稳定。连接状态用明确的进程间消息和带时效的往返探测更新，分别表达服务启动、远程可达、执行器可用。本次没有主动断网或制造半开连接，关于误报的判断来自代码，不是现场断线实验。

### 缓存改善了打开速度，却没有完整的更新和存储边界

缓存优先值得保留，但当前缓存成功后立即返回旧数据并启动后台命令，后台失败被忽略。去重记录在旧数据返回后就删除，没有覆盖后台刷新整个生命周期，同一个读取可以反复排队。刷新成功也不会直接替换当前调用已拿到的旧结果，需要后续读取才看到更新。云端投影读取没有到期判断。这会让界面看上去已加载，却持续看不到新状态。

依据是 [personal-node-fetch.ts:215](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/web/src/lib/personal-node-fetch.ts#L215)、[缓存返回与后台刷新:253](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/web/src/lib/personal-node-fetch.ts#L253) 和 [getAlphaProjection:613](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/local-relay/src/index.ts#L613)。设备列表非成功响应还会被处理成没有设备，认证或服务故障因此被换成了错误的问题描述。

存储边界也需要说明。现在符合规则且不超过 96 KiB 的成功 GET 响应会完整保存在云端；允许规则只排除 local-mode 和 Space 环境变量接口，并非只允许工作区名称等摘要。因此文件预览、会话内容也可能成为持久缓存，不能将此产品描述为一切内容只留在本机。这里没有发现或验证越权泄露，也没有读取敏感文件；结论仅是内容保留范围比元数据更广。[投影内容:16](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/local-relay/src/alpha-projection.ts#L16)、[允许规则:642](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/local-relay/src/protocol.ts#L642)。

建议把本机缓存与供异地访问的云端缓存区分，给云端缓存明确的字段范围、保留时间和清除行为。界面携带更新时间，后台刷新失败显示旧数据状态，不伪装成最新。合并刷新应持续到刷新真正结束，而不是持续到旧内容被返回。

### 安装包距离普通用户的完整入口仍有缺口

现有 alpha.4 为 macOS ARM64，磁盘镜像约 314 MB，内嵌运行归档约 707 MB。对已经生成的应用直接读取签名，结果是 Signature=adhoc、TeamIdentifier=not set。这种完整性检查通过，不等于具备正常面向用户分发的开发者签名和公证。Electron 官方的 macOS 发布流程要求签名并公证；当前不能把另一台电脑需要绕过安全提示当作自然安装体验。[打包配置:51](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/desktop/package.json#L51)。

Pi 被打包不等于首次安装即可推理，仍需有效的提供方凭据。其他执行器依赖宿主机安装和登录。已有 readiness 改动将缺失状态显式展示，这是正确的改进，但尚未解决产品层面的首次可用入口。正式对外前应明确先支持哪类 Mac，以及普通用户如何在安装、登录后完成第一条任务，不把环境准备问题统称为连接失败。

本地运行归档按哈希区分、校验后解压，数据与程序目录分开，这些应保留。不过自动更新、旧数据升级和回退到旧程序的兼容约定尚未完整。尤其程序可以换回旧版，不代表已变更的数据格式可以安全退回。签名、更新和旧数据恢复应作为交付链路处理，而不是只检查安装包能生成。

## 值得优化但不宜先重写

当前安装包复用了云端完整服务栈，包括 Postgres、Valkey、对象存储、API、Gateway、多个 worker 和 Agent。这样保留既有能力有实际价值，但普通用户因此承担了服务编排和启动成本。[启动顺序:529](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/desktop-runtime/manager.mjs#L529)显示迁移检查与目录同步在 API 启动之前。现有开发记录报告优化后首次测得启动约 47 秒、下一次约 33 秒；这是历史记录，不是本次重新测量的性能。

合理的瘦身顺序是先测清解压、认证、迁移检查、目录同步、API 与执行器准备各阶段，再把非首屏必需服务延后启动。不能仅凭进程多就换数据库，也不能用跳过迁移检查或吞掉启动错误换速度。当前没有证据表明把 Electron 换成 Tauri，或把 Postgres 换成 SQLite，能先解决已复现的结果丢失和排队问题。

测试重点也要变化。现有测试覆盖了许多队列、协议校验、单接口超时和执行器行为，但本次缺陷发生在云端与电脑的消息交错之间。现有 node 测试没有覆盖 index.mjs 的这段完整调度交互；单接口超时测试又先让认证成功，无法证明认证阶段有截止时间。[现有超时测试:316](https://github.com/atou42/cohub-local-mode/blob/f9e17c1609fc0e5642a05f2466194ea762939be4/apps/local-relay/node/core.test.mjs#L316)。增加类似功能单元的通过数量，不能替代对结果真正送达的验证。

## 推荐的目标结构

本机能力和异地访问应共享业务能力，不共享全部失败条件。本机客户端复用现有界面与服务，通过受控的本机连接访问自己的工作区、会话、文件和执行器。菜单栏 Connector 继续负责后台运行和恢复，关闭窗口不结束任务。要保证的不是模型完全离线运行，而是云端中转不可达时，本机文件、历史和本机服务管理仍能正常使用；外部模型和组织服务仍按各自条件联网。

云端保留统一登录、设备注册与撤销、异地连接、必要的内容投影。手机或另一台电脑访问时才经过远程通路。历史设计已明确要求手机访问，因此这不是删掉远程能力，而是不让同机使用无条件依赖它。多人共享和全量跨设备文件同步仍不属于当前已确认的安装版需求，不应夹带进入这次改造。

Cloudflare 不需要用户各自配置，由产品维护公共服务即可满足原始目标。现有向外建立连接、设备凭据可撤销、账号隔离、Keychain 保存凭据、与生产资源分离的做法都应保留。官方 Durable Objects WebSocket 文档明确支持长连接和休眠时保留连接，因此没有依据把这次故障直接判成 Cloudflare 不适合；当前证据首先指向应用自己的状态和调度规则。

最小调整顺序应是先修结果确认、执行身份和超时语义，形成一条不会丢结果的完整路径；随后打通本机直接使用，同时处理远程读取排队、缓存更新和可信状态；最后在真实目标 Mac 上完成签名安装、首次任务、睡眠唤醒、网络切换以及带旧会话和文件的升级恢复验证。更换运行底座和扩大操作系统支持放在有证据需要时再做。以上是建议顺序，本次没有授权实施这些改动。

## 版本与观察边界

对应本地仓库是 `/Users/atou/agents-in-discord/workspaces/1540358055563100230/cohub-local-mode`，自己的 GitHub 仓库为 `https://github.com/atou42/cohub-local-mode`，上游为 `https://github.com/talesofai/cohub`。审视分支为 feat/cloudflare-personal-node-alpha，HEAD 为 f9e17c1609fc0e5642a05f2466194ea762939be4，远端同名分支一致。此前部署 cohub.atou.cc 的 main 与这条安装版分支不同，不能把生产 main 已合并部署等同于安装版也已验收。

dev 网页实时构建标识 1788489511543 与本地构建产物一致，Cloudflare 当前 Web 版本为 507fce33-361d-4ce7-b3a9-50036d29d222，部署于北京时间 2026-09-04 11:45；Relay 版本为 ec2a6f72-2424-4d2c-bc5d-48a0a740e5f5，部署于 2026-09-03 19:38。部署记录、现有 ledger 与本地产物相互吻合，但本次没有下载线上 Worker 源码逐字节比较。

北京时间 2026-09-05 20:27 的只读观察中，10 条注册记录有 5 条未撤销，5 条全部离线，没有正在执行的命令。MacBook 最后上报的是 alpha.2、stopped，时间为 2026-09-04 08:10；这只能证明最后一次上报，不能证明它现在装的仍是旧版。网页能登录、能展示缓存，并明确提示 Local Mac is offline；现场截图（历史本地证据，未随仓库发布：`/Users/atou/agents-in-discord/workspaces/1545762101967196260/.review/alpha-desktop.png`）已检查。

因此本报告不宣称现有 alpha.4 已经稳定，也不宣称做过真实在线客户端的持续测试。当前证据足以否定只要换条线路或多加重试就能解决的解释，并给出明确的修复优先级。实际设备上的长时间运行、睡眠恢复与首次推理仍需要后续实施阶段验证；本次没有为获得这些数据擅自启动或改动服务。

本次未改动目标仓库的已跟踪文件。原有未跟踪 docs/plans/ 保持原状。新文件只在本线程 deliverables/ 与 .review/，未保存账号令牌、密钥或命令内容。

## 外部依据

Cloudflare 官方 Use WebSockets 文档，2026-09-05 读取，说明 Durable Objects 支持长连接及休眠时保留连接。地址 `https://developers.cloudflare.com/durable-objects/best-practices/websockets/`。这里只用于排除平台必然不支持这一误解，不用平台文档证明当前产品可靠。

Electron 官方 Code Signing 文档，2026-09-05 读取，说明 macOS 面向用户发布的签名和公证要求。地址 `https://www.electronjs.org/docs/latest/tutorial/code-signing`。本次实际包的签名状态来自本机 codesign 只读结果，而不是对文档的推测。
