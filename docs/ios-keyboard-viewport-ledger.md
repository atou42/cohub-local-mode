# iOS 键盘视口修复记录

## 当前状态

修复和本地回归已经完成。问题已由用户提供的 iOS 实机截图确认。输入结束且键盘收起后，应用主体停留在较小高度，底部露出约一百个 CSS 像素的白色页面背景；同一页面的正常截图没有该空白。当前机器没有 Xcode 和 iOS Simulator，仍需 iOS 实机复测后才能完成最终验收。

## 已确认事实

- 应用以 iOS standalone PWA 运行，页面外壳当前使用 `100dvh`。
- 输入框会在发送时主动失焦，外壳没有处理键盘关闭后的视口恢复。
- WebKit 已记录 standalone PWA 在键盘关闭后保留错误视口高度的问题，包括 [WebKit 218983](https://bugs.webkit.org/show_bug.cgi?id=218983) 和 [WebKit 301857](https://bugs.webkit.org/show_bug.cgi?id=301857)。
- 修复范围限于 iOS standalone PWA 的应用外壳高度恢复。桌面、普通浏览器标签页、Android、聊天内容和安全区主题不进入改动范围。

## 失败证据

- `.cohub/relay-attachments/6ef48a3e-29fb-42d5-b924-04abba5ef0af/IMG_0257.jpg` 显示键盘收起后的底部白色留白。
- `.cohub/relay-attachments/6bd7628d-752d-43ba-a44e-fe9a327d2bcb/IMG_0258.jpg` 显示同一页面的正常初始状态。
- 新增的定向测试首次运行失败，提示缺少 `$lib/ios-standalone-viewport`，证明当前代码没有目标恢复行为。

## 决策

保留键盘出现时 `100dvh` 的动态收缩。输入聚焦前记录完整外壳高度，失焦后恢复该高度，避免依赖 WebKit 已经失真的关闭后视口值。恢复逻辑只在已安装的 iOS PWA 中启用。

## 已完成工作

- 新增 `ios-standalone-viewport.ts`，识别 iOS standalone PWA，记录输入聚焦前的完整高度，并在失焦后恢复。
- 应用外壳改为使用可恢复的高度变量。没有改变安全区、Space 背景、聊天内容和输入框样式。
- 新增状态回归，覆盖键盘收缩、关闭后错误高度、连续开合、横竖屏变化、聚焦时旋转和坏尺寸。

## 验证证据

- 修复前定向测试失败，缺少目标恢复模块；修复后相关测试共 11 项通过。
- Web 前端完整测试共 398 项通过。
- 共享浏览器中的移动尺寸交互检查把外壳从 852 像素模拟压缩到 744 像素，输入失焦后恢复为 852 像素。
- 改动文件的格式检查、差异检查和独立 TypeScript 检查通过。
- 全量类型检查运行到结束，只有两个与本次改动无关的既有测试类型错误，改动文件没有报错。
- 本机只有 Command Line Tools，没有 Xcode、`simctl` 或 iOS Simulator，因此浏览器模拟结果不能代替 iOS 最终证据。
- 本机没有连接中的 iPhone 或 iPad，也没有 `idevice_id`、`ios_webkit_debug_proxy` 等真机调试工具，无法从当前环境补齐实机证据。

## 下一步

在 iOS standalone PWA 中连续执行输入、发送、点击完成和再次输入，确认每次键盘收起后输入框都贴回底部且没有白色留白；通过后记录设备与系统版本，完成验收。
