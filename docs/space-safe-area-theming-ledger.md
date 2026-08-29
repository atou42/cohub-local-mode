# Space 安全区主题 Goal Ledger

## 2026-08-29 任务建立

目标是在 Cohub Web/PWA 中让 iPhone 刘海和灵动岛周围的安全区成为当前 Space 主题的一部分。Space 背景必须从屏幕顶端连续铺设，导航和其他可交互内容仍位于安全区内侧。切换或离开 Space 后必须恢复普通 Cohub 主题。

设计模式为 balanced。视觉判断是不新增可见控件，也不复制背景图，而是让现有 `.app-shell` 背景层覆盖完整 viewport；安全区只负责保护内容位置。交互上没有动画，Space 切换沿用现有样式加载和恢复流程。

现状证据如下。

- `apps/web/src/app.html` 的 viewport 缺少 `viewport-fit=cover`，因此 iOS 会为非矩形屏幕保留页面外侧区域。
- `apps/web/src/app.css` 已让 `.app-shell` 使用 `--app-bg-*` 主题变量绘制背景，但外壳没有顶部安全区内边距。
- `.cohub/theme.css` 由 `apps/web/src/lib/space-style.ts` 注入，并能覆盖 `--app-bg-*`。本功能应复用这一合同，不增加 Space 对宿主 DOM 的新权限。
- Apple 的 Web App 文档只为 standalone PWA 提供 `default`、`black` 和 `black-translucent` 状态栏模式。透明背景需要 `black-translucent`，系统图标颜色不能像原生 UIKit 那样按 Space 任意动态控制。浏览器可通过 `theme-color` 选择周边 UI 颜色，但这不是与原生 `UIStatusBarStyle` 等价的保证。

当前合同决定如下。

- 开启 `viewport-fit=cover`，由 `.app-shell` 的同一背景层覆盖顶部安全区，避免图片缩放和定位断层。
- 用 `env(safe-area-inset-top/right/left)` 保护外壳内容；底部继续沿用现有组件级处理，避免输入框被重复抬高。
- Space 可用 `--cohub-safe-area-background` 覆盖顶部安全区，默认值为 `transparent`，因此默认直接显示连续的 `.app-shell` 背景。
- Space 可用 `--cohub-status-bar-color` 提供合法 CSS 颜色，Cohub 将其同步到 `theme-color`。无效值、透明值或缺失值恢复当前全局主题色。
- `apple-mobile-web-app-status-bar-style` 使用 `black-translucent` 以允许背景进入 iOS standalone 状态栏。系统图标的最终深浅仍受 iOS 限制，不能伪装成可由 CSS 完整控制。

不得退化的行为包括桌面布局、Android、普通 Safari、移动端抽屉、顶部导航、输入框和键盘、Space 样式缓存、Space 切换以及无 `.cohub/theme.css` 时的默认主题。

下一步是先写合同和恢复路径测试，再实现 viewport、安全区外壳和 `theme-color` 同步。

## 2026-08-29 实现与中段验证

已完成的实现如下。

- `app.html` 已启用 `viewport-fit=cover` 和 iOS standalone 状态栏元数据。首屏内联主题逻辑会在 hydration 前根据全局明暗主题选择 `default` 或 `black-translucent`，减少首屏状态栏闪烁。
- `.app-shell` 现在由同一个全 viewport 背景层覆盖顶部安全区，内容使用 top、left、right inset 避让。移动端左右抽屉在固定定位场景下独立应用安全区内边距。
- `.cohub/theme.css` 新增 `--cohub-safe-area-background`、`--cohub-status-bar-color` 和 `--cohub-status-bar-style` 合同。前者默认透明，以保留背景图连续性；后两者分别控制浏览器主题色和 iOS standalone 状态栏的深浅策略。
- 新增 `space-chrome-theme.ts`，只接受浏览器支持且非透明的颜色，以及 `light`、`dark` 两种状态栏风格。空值、`auto`、透明、无效颜色和无效风格均恢复当前 Cohub 全局主题。Space 样式加载、刷新、卸载及全局主题切换都会重新同步。

验证过程保留的失败证据如下。

- 首次全量 Web 测试因 `@cohub/protocol/dist` 尚未构建而失败，不是业务断言失败。完成 `@cohub/protocol` 和 SDK 本地构建后，同一 Web 测试通过 340 项。
- 首次 Web typecheck 因缺少 `PUBLIC_API_ORIGIN`、`PUBLIC_GATEWAY_ORIGIN` 和 `PUBLIC_COHUB_ENV` 的本地声明而失败。按仓库 `.env.example` 注入开发值并重新生成 SvelteKit 类型后，结果为 0 error、0 warning。

当前正向证据如下。

- 新增合同测试覆盖合法颜色、空值、透明值、非法颜色、合法/非法状态栏风格、Space 到全局主题的连续恢复、缺失 meta 元素，以及 viewport 和安全区 CSS 合同。当前 6 项通过。
- Playwright 在 430×932 模拟 59px 顶部安全区时，验证 `.app-shell` 高度与 viewport 同为 932px、页面无额外滚动、导航顶部为 59px、安全区覆盖层高度为 59px且默认透明，背景图由同一个 `.app-shell` 绘制。显式安全区颜色覆盖也已截图确认。
- 1440×900 且安全区为 0 时，外壳高度为 900px、页面无额外滚动、导航顶部为 0，桌面布局没有被抬高。
- Web build 已成功完成。构建存在仓库原有的 `PUBLIC_PREVIEW_ORIGIN` 缺省和 `vconsole` eval warning，未出现本功能新增的构建错误。

iOS 限制仍按真实能力处理。`black-translucent` 可以让深色背景图进入状态栏并使用浅色系统图标；浅色纯色主题默认使用 `default` 和深色系统图标。浅色图片若要求完全透明又要求深色系统图标，Web/PWA 没有与 UIKit 等价的动态能力，Space 应通过安全区背景覆盖或选择浅色图标策略保证对比度。

下一步是按最终代码重新运行格式、单测、typecheck 和 build，复查 git 现场并完成逐项验收。

## 2026-08-29 最终验收

最终代码已通过定向格式与静态检查。新增的 6 项安全区合同测试全部通过，Web 全量测试共 342 项全部通过，Svelte typecheck 为 0 error、0 warning，生产 build 成功生成 Web 与 PWA 产物。构建只保留仓库原有的 `vconsole` eval、AudioPlayer 动态导入和插件耗时提示，没有本功能新增的错误。

最终视觉复查覆盖 430×932、59px 顶部安全区的竖屏场景，以及 1440×900、0px 安全区的桌面场景。移动端确认背景连续铺到 viewport 顶部，导航从安全区下沿开始，页面高度没有增长，也没有额外滚动；显式 `--cohub-safe-area-background` 只覆盖顶部区域。桌面端外壳与 viewport 同高，导航保持在顶部，布局未被抬高。证据保存在 `output/playwright/safe-area-mobile.png`、`output/playwright/safe-area-override-mobile.png` 和 `output/playwright/safe-area-desktop.png`。

失败路径也已覆盖。非法或透明状态栏颜色、非法状态栏风格、缺失 meta 元素、Space 样式移除和全局主题切换都不会留下上一 Space 的状态。安全区能力在不支持 `env()` 或 inset 为 0 的平台上自然退化为原布局，不依赖静默 fallback 掩盖坏数据。

验收结论为通过。当前机器没有可用的 iOS Simulator 或实体 iPhone 调试链路，因此系统状态栏的最终像素表现以 Apple 的公开能力约束、元数据映射测试和等尺寸安全区模拟共同证明。真实设备仍是发布前的剩余平台风险，但不影响本次代码范围的完成判断。

## 2026-08-29 Local Mode 发布准备

发布目标是 `atou42/cohub-local-mode` 和受 Cloudflare Access 保护的 `https://cohub.atou.cc`，不是 `talesofai/cohub` 上游服务。上游没有收到本功能的提交、分支或 Pull Request。

## 2026-08-29 Local Mode 发布验收

改动已合入 fork 的 `main`，通过 Local Mode 的原子构建流程发布，并只重启了一次 `cc.atou.cohub-local-mode` 服务。Postgres、Redis、对象存储、API、Gateway、Web、Private ingress 和 Cloudflare relay node 全部恢复 ready；Cloudflare Tunnel 服务保持 running。

fork 当前 Web 全量测试共 394 项通过，受影响文件 lint 通过，Local Mode 生产构建成功。fork 的全量 typecheck 仍被两个本功能之外的既有测试类型错误挡住，分别位于 `models-status-cache.test.ts` 和 `palette-overview-local.test.ts`；本功能的源码和测试没有新增诊断。

未认证访问 `https://cohub.atou.cc` 会按预期进入 Cloudflare Access。使用现有认证会话访问真实 Local Space 成功，桌面 1440×900 和移动 430×932 均无控制台错误、额外页面滚动或明显布局错位。线上文档已包含 `viewport-fit=cover` 和 iOS 状态栏 meta，Space chrome 合同已进入实际构建。

VERDICT: PASS
