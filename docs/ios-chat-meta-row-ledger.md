# iOS Chat 信息行宽度修复记录

## 当前状态

实现、提交、生产部署和线上验收已经完成。产品提交为 `aac9c1e3f4d8c81409df48138db9689af5698175`，远端 `fork/main` 已确认与该提交一致。`.playwright-cli` 是既有未跟踪目录，没有进入提交。

## 目标与边界

Chat 消息底部信息行必须在窄屏内保持单行并受消息宽度约束。支持 Fork 的消息始终保留复制和 Fork 两个等尺寸按钮；模型名优先省略；Effort 使用 `O`、`Min`、`L`、`M`、`H`、`xH`、`Max`、`U`；可见缓存信息只显示括号数字，完整含义保留在详情中。不得改变 Fork 资格、API、数据、权限、中继、基础设施和其他页面行为。

## 修复前证据

- 用户截图 `.cohub/relay-attachments/35476780-85e2-4f5a-904a-9b573f1db38e/IMG_0271.jpg` 显示长信息行把左侧按钮和内容挤出屏幕。
- 用户截图 `.cohub/relay-attachments/1ddc81ac-052f-466a-ae1e-604ff1ea2f22/IMG_0272.jpg` 显示预期的复制、Fork 同形按钮和可省略模型名。
- 代码检查确认模型名已有省略能力，但 Effort、token、缓存说明、耗时和时间均为不可收缩项，固定内容之和仍可超过移动宽度。
- 新增的四项定向检查在修复前全部失败，分别证明缺少宽度边界、共享按钮样式、紧凑缓存显示和 Effort 缩写。

## 已完成工作

- 信息行和中间元数据组增加明确的宽度与溢出边界，模型名承担剩余空间并优先省略，时间和操作按钮保持固定。
- 复制和 Fork 使用同一个按钮样式常量，保留原有资格、点击、禁用和加载逻辑。
- 可见缓存从带本地化说明文字的格式缩短为括号数字，详情文字保持不变。
- 共享紧凑 Effort 映射改为 `O`、`Min`、`L`、`M`、`H`、`xH`、`Max`、`U`，同时覆盖消息信息行和 Prompt 控件。

## 验证证据

- 定向检查修复后 8 项通过。
- Web 完整测试 405 项通过。
- 四个改动代码或测试文件的 Biome 检查通过，`git diff --check` 通过。
- Local Mode 原子构建成功。构建只出现既有的可选 `PUBLIC_PREVIEW_ORIGIN` 和第三方 `vconsole` 警告。
- 使用正确 Local Mode 构建目录和环境执行类型检查，只有两个未修改测试文件中的既有错误：`models-status-cache.test.ts` 的 `samples1h` 和 `palette-overview-local.test.ts` 缺少 `agentHarness`；本目标文件没有诊断。
- 生产页面现有数据经临时 DOM 方式套用候选布局后，在 320、393、430 像素视口下页面与每条信息行的 `scrollWidth` 均等于 `clientWidth`，没有可见溢出；复制和模拟 Fork 按钮尺寸一致，目标行显示 `H` 与括号缓存数字。该证据只验证布局规则，不替代部署后的真实产物验收。

## 安全门

已重新运行 `repo_safety_scan.sh`。部署入口、Web 包脚本、Local Mode 构建脚本和 `wrangler.local-mode.toml` 与上一轮已审计发布保持一致，本次差异没有触及这些文件。

`VERDICT: LIMITED_EXEC_OK`

允许执行限定的 Web 测试、格式与类型检查、Local Mode 原子构建、精确 Git 提交和非强制推送、`cohub-local-web` 精确部署、生产页面只读验收与服务状态检查。禁止执行依赖安装、全局安装、服务安装或卸载、数据库迁移、基础设施变更、强推、工作区清理和无关部署脚本。

## 阻塞与下一步

当前没有代码阻塞。发布前服务检查显示 Postgres、Redis、对象存储、API、Gateway、Web、Private ingress 和 Cloudflare relay node 全部 ready，Tunnel 由 `launchctl` 确认为 running。`HEAD`、`FETCH_HEAD` 和 `fork/main` 均为 `354ac76e724278a0e7bbeb2f1db72d6a4ba288f1`，远端没有待整合提交。发布前 Worker 版本为 `4e895ea4-01d1-4df6-9251-d82fba115e91`，作为本次回退目标。

当前机器没有 Xcode、iOS Simulator 或连接中的 iPhone，真实 iOS standalone PWA 复测只能作为外部确认项记录，不能由浏览器模拟替代。该外部确认项不改变本次代码、部署和线上浏览器验收结果。

## 发布与线上验收

- 精确提交 `aac9c1e3f4d8c81409df48138db9689af5698175` 已通过非强制推送进入 `fork/main`。提交只包含两个实现文件、两个测试文件和本记录。
- Local Mode Web 已部署到 `https://cohub.atou.cc`，Worker 版本为 `efc5897a-e031-4f49-92d8-790486721e39`，流量为 100%。发布前版本 `4e895ea4-01d1-4df6-9251-d82fba115e91` 保留为回退目标，本次没有触发回退。
- 生产页面绕过缓存与 Service Worker 强制重载后，实际加载了候选构建资源 `start.DKRKIzYG.js`、`app.Bf1H-08w.js` 和 `Cop8y2zl.js`，页面没有脚本异常。
- 在真实生产消息数据上，320、393、430 像素视口的页面、Chat 外层和全部信息行均满足 `scrollWidth === clientWidth`，没有页面或信息行横向溢出。极端样本显示 `GPT-5.6-Sol H ↑224.0M (110.9M) ↓182.1k 4分 41秒 07:50`；320 像素时模型名收缩到零剩余宽度，固定信息和时间仍在行内。
- 中文与英文运行时切换均验证通过。两种语言的可见信息行都没有 `cached` 或缓存文字，详情分别保留完整缓存含义；浏览器语言偏好已恢复为原来的 `zh-CN`。
- 另一条生产 Session 同时包含五条支持 Fork 和五条不支持 Fork 的消息。在 320、393、430 像素视口下，支持 Fork 的行始终显示两个按钮，复制与 Fork 的 class、23×18 像素尺寸一致，时间和整行保持在边界内；不支持 Fork 的消息没有被错误添加按钮。
- 新共享浏览器标签页连续执行两次斜向上滑，Chat 纵向位置从 500 变为 1102，再变为 1725，横向位置始终为 0。第一次在旧标签页上的 CDP 输入命令超时，刷新没有解除该标签页的输入占用；换用同一共享浏览器的新标签页后相同检查通过，没有把失败隐藏为成功。
- 左右屏幕边缘滑动都正常打开对应抽屉，两个面板均进入 `translateX(0)`。真实代码块保持 `overflow-x: auto` 和 `touch-action: pan-x pan-y`；部署后的 CSS 还用 600 像素宽临时表格验证了表格容器的 `overflow-x: auto`、横向边界包含和局部横滑能力。
- 桌面 1440×900 视口页面宽度为 1440 像素，62 条信息行没有溢出，桌面侧栏正常显示。
- 生产重载只有历史消息中的本地附件路径、`favicon.ico` 和既有受限 Apps 接口返回 404 或 403；候选构建资源和核心页面请求没有失败。
- 发布后 Postgres、Redis、对象存储、API、Gateway、Web、Private ingress 和 Cloudflare relay node 全部 ready，Tunnel 仍由 `launchctl` 确认为 running。

`VERDICT: PASS`
