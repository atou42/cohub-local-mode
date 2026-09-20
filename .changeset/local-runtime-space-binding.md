---
"@neta-art/cohub-cli": patch
---

Local Runtime remembers a Space per canonical directory, account, and environment, so repeated `cohub runtime up` commands reuse the same Space. Explicit Space targets update the binding, and space-scoped CLI commands use the current directory binding before Home.

Local Runtime 按规范化目录、账号和环境记住对应的 Space，重复执行 `cohub runtime up` 时复用同一个 Space。显式 Space 目标会更新绑定，其他 Space-scoped CLI 命令也会优先使用当前目录绑定，再回退到 Home。
