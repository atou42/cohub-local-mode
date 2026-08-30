# iOS 移动端修复生产发布记录

## 发布目标

将 iOS 键盘收起后的底部留白修复和 Chat 消息列表横向漂移修复，以一个可审计提交推送到 `atou42/cohub-local-mode` 的 `main`，并通过现有 Local Mode Web 发布流程部署到 `https://cohub.atou.cc`。

## 范围边界

提交只包含两项修复、对应测试和三份验收记录。`.playwright-cli`、依赖目录、构建缓存、凭证、API、数据、权限、中继和基础设施配置都不进入提交或变更范围。

## 发布前状态

- 工作分支为 `deploy/safe-area-regression-fix`，起点为 `6a9ae34d`，跟踪 `fork/main`。
- 已获取远端，`HEAD`、`fork/main` 和 `FETCH_HEAD` 都是 `6a9ae34d`，远端没有待整合提交。
- 两项修复仍是本地未提交改动，生产页面仍使用旧的 `100dvh` 外壳和允许横向回弹的 Chat 滚动边界。
- 生产 Web Worker 为 `cohub-local-web`，目标路由来自 `apps/web/wrangler.local-mode.toml`。
- 发布前 Worker 版本为 `b5b0b7ca-1c61-4b32-9fdb-95e358c39a17`，失败时回退到该版本。
- 当前持久服务从 `/Users/atou/agents-in-discord/workspaces/1540358055563100230/cohub-local-mode` 运行，该目录有另一项正在进行的未提交工作。本次不会修改、拉取、清理或覆盖该目录；构建仅只读使用它现有的 Local Mode 环境文件，并在当前干净隔离的修复工作区生成和部署 Web 产物。

## 安全门

已运行 `repo_safety_scan.sh` 并补读根目录与 Web 的 `package.json`、`scripts/local-mode/run.mjs`、`apps/web/wrangler.local-mode.toml` 和 Web Cloudflare 发布工作流。

`VERDICT: LIMITED_EXEC_OK`

允许执行限定范围的 Git 检查、获取、提交和推送，Web 测试、格式检查、类型检查、Local Mode 原子构建、`cohub-local-web` 精确部署、服务状态检查和生产页面只读验收。禁止执行全局安装、服务安装或卸载、数据库迁移、基础设施变更、强推和无关发布脚本。

## 发布结果

远端和回退点已经确认。直接在修复工作区运行 `local:status` 因缺少该隔离工作区自己的 Local Mode 环境文件而按预期失败，没有修改服务；改为显式只读使用持久服务目录的环境文件后，Postgres、Redis、对象存储、API、Gateway、Web、Private ingress 和 Cloudflare relay node 全部为 ready。Tunnel 的封装状态命令受当前环境无法读取进程列表影响而失败，随后通过 `launchctl` 确认 `cc.atou.cohub-local-tunnel` 处于 running，公网入口返回 Cloudflare Access 跳转。

发布前 Web 完整测试 401 项通过，七个改动代码文件的格式检查和差异检查通过。全量 Web 类型检查运行到结束，只报告两个未修改测试文件中的既有类型错误：`models-status-cache.test.ts` 仍使用已移除的 `samples1h`，`palette-overview-local.test.ts` 的旧夹具缺少 `agentHarness`；本次改动文件没有诊断。

暂存区逐文件审计后只包含四个既有 Web 文件、三个新增 Web 代码或测试文件和三份 iOS 验收记录，共十个文件；`.playwright-cli` 保持未跟踪且未暂存。敏感值扫描没有命中。

产品提交为 `73ecfa2a5b9f66a38905478814aea3cd2845f36a`，提交信息为 `fix(web): stabilize iOS chat viewport`。已用非强制推送发布到 `fork/main`，随后再次读取远端引用，确认远端 `main` 与该完整提交一致。

Local Mode Web 原子构建完成，发布产物包含新的应用外壳恢复逻辑、Chat 横向锁定样式和对应资源。Cloudflare Worker `cohub-local-web` 已部署为版本 `4e895ea4-01d1-4df6-9251-d82fba115e91`，流量为 100%。发布前版本 `b5b0b7ca-1c61-4b32-9fdb-95e358c39a17` 保留为回退点，本次没有触发回退。

生产页面通过共享登录浏览器绕过缓存和 Service Worker 强制重载。移动视口下，页面宽度与 393 像素视口一致；Chat 外层计算样式为横向隐藏和禁止横向边界回弹。斜向上滑后纵向位置从 500 移到 683，横向位置保持为 0。左右屏幕边缘滑动均正常打开对应抽屉，面板变换归零。代码块仍保留局部横向滚动。模拟键盘把可视高度从 852 压到 744 像素，失焦并恢复视口后应用外壳回到 852 像素。桌面 1440×900 视口下页面宽度没有溢出，侧栏、主区和 Chat 布局正常。

生产重载没有脚本异常。网络中出现的失败请求只有历史消息里的本地附件路径、`favicon.ico` 和既有受限 Apps 接口，不属于本次发布资源或核心页面链路。发布后再次检查服务，Postgres、Redis、对象存储、API、Gateway、Web、Private ingress 和 Cloudflare relay node 全部为 ready，Tunnel 仍处于 running。

## 剩余证据

当前机器没有 Xcode、iOS Simulator 或已连接的 iPhone，因此生产页面的真实 iOS standalone PWA 复测仍需在用户设备完成。部署和线上模拟验收已经完成，但只有实机连续执行键盘开合与斜向滚动后，才能关闭两项 iOS 问题的最终设备验收。
