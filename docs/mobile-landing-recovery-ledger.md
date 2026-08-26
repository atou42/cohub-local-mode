# 移动端首页恢复台账

## 目标

恢复 `https://cohub.atou.cc` 在移动端的完整样式与 Start 交互，并阻止本地生产构建再次把正在服务的页面暴露为半成品。

## 范围

只处理首页静态资源、客户端启动、移动端布局、构建发布顺序和缓存验证。不调整 Agent、本地 Space、Cloudflare 中继或产品设计。

## 现场证据

- 2026-08-26 用户在 iPhone 实机看到无样式的首页，桌面内容按原始宽度挤入窄屏，Start 按钮点击无反应。截图保留在本线程附件 `IMG_0185.png`。
- 同一页面的服务端 HTML 含有正常的样式链接和 Start 按钮；Start 是依赖客户端启动后绑定行为的普通按钮。截图形态与样式和脚本未成功加载一致。
- 本地服务从 `apps/web/.svelte-kit` 直接读取并监听运行中的构建产物。`pnpm local:build` 也会原地改写同一目录。
- `~/.cohub-local-mode/logs/host.stderr.log` 在 2026-08-26 12:43 记录运行中的 Web Worker 连续找不到 `output/server/nodes/*.js`，最终以 17 个错误结束构建。这证明服务曾在构建更新期间读到不完整目录。

## 根因

生产构建和在线服务共享可变的 `.svelte-kit` 目录。构建期间旧文件被移除，新文件尚未全部生成，在线 Worker 因而读到不完整目录。首页 HTML 继续由 Mac mini 经 Tunnel 返回，`/_app` 静态资源却由另一个 Cloudflare Worker 版本返回；只更新本地构建而没有同步部署静态资源时，HTML 会引用线上不存在的 CSS 和 JavaScript。两个条件叠加后，浏览器只能显示原始 HTML，Start 也没有客户端行为。

线上缺失的 immutable 资源还错误携带一年缓存头，会放大版本不一致。Web App Manifest 没有携带 Cloudflare Access 凭据，也会产生一个独立的资源失败。

## 修复

`pnpm local:build` 现在只写入独立暂存目录。暂存构建必须包含服务端入口、客户端入口、版本文件和样式文件，验证通过后才切换为当前版本；失败构建会留在现场，上一份可用版本保持不变。

本地静态资源代理和线上 Web Worker 都会把缺失 immutable 资源明确返回为不可缓存的 404。Manifest 请求会携带同源凭据，两个 Manifest 路径都由同一份线上静态资源版本提供。

公网首页现在与 `/_app` 静态资源由同一个 Cloudflare Worker 版本返回。本地下一次构建不会在部署前改变公网首页，也不会再产生新 HTML 配旧静态资源的窗口。

修复后的 Web 版本已部署到 Cloudflare，版本 ID 为 `92671f0e-f49b-46a4-bbe7-05c9269ebfcf`。

## 验收记录

状态：通过。

线上真实页面在 390 × 844 的移动视口中宽度为 390，没有横向溢出，样式、字体和六张图片全部正常。可见 Start 按钮尺寸为 51.2 × 30，连续触发两次后进入当前用户的 Space 新会话页。首页自身没有资源失败、控制台错误或运行时异常。截图保存在 `~/.cohub-local-mode/recovery/2026-08-26-mobile-landing/mobile-live.png`。

线上桌面页面在 1440 × 900 视口中完整加载，没有横向溢出、坏图、资源失败、控制台错误或运行时异常。截图保存在 `~/.cohub-local-mode/recovery/2026-08-26-mobile-landing/desktop-live.png`。

模拟 300 毫秒延迟和 750 Kbps 下载速度时，移动页面在 6.8 秒内完成加载，样式和 Start 行为保持正常。启用浏览器缓存及 Service Worker 的再次访问在 0.3 秒内完成。不存在的 immutable 资源返回 404 和 `Cache-Control: no-store`。

构建发布测试覆盖不完整暂存版本拒绝发布、完整版本切换和缺失资源不缓存，共 3 项全部通过。带 Local Mode 环境的 Web 类型检查为 0 错误、0 警告，全部本地服务与 Cloudflare relay 均为 ready。

部署前发现上游迁移记录与本地数据库时间戳不一致。完整备份保存在 `~/.cohub-local-mode/recovery/2026-08-26-mobile-landing/`，核对并补齐唯一缺失的迁移后服务恢复；没有删除或重建原数据。

Start 进入 Space 后，现有模型目录偶发报告配置结构无效。它不影响首页样式、客户端启动或 Start 跳转，属于本次范围外的 Agent 配置问题，现场日志已保留。
