# Cohub Gateway 部署

Gateway 负责维护与第三方 IM 平台（Discord、Telegram、Feishu 等）的长连接，同时提供 HTTP API 供 Session Runtime 调用。

## 架构特点

- 使用 **StatefulSet** 部署，保证 Pod 名字固定（如 `cohub-gateway-dev-0`）
- 通过 **Redis Streams** 与 API 通信
- 提供 **HTTP API**（默认 8788 端口）供 Session Runtime 调用
- 支持多副本水平扩展，API 自动分配 Channel 到各个节点
- 通过 **HTTPRoute** 暴露外部访问（可选）

## 目录结构

```
gateway/
├── manifests/           # K8s 资源模板
│   ├── configmap.tmpl.yaml
│   ├── statefulset.tmpl.yaml
│   ├── service.tmpl.yaml
│   └── httproute.tmpl.yaml
├── dev/                 # Dev 环境配置
│   ├── values.yaml
│   ├── secrets.yaml
│   └── deploy.sh
└── prod/                # Prod 环境配置
    ├── values.yaml
    ├── secrets.yaml
    └── deploy.sh
```

## 部署步骤

### 1. 构建并推送镜像

```bash
cd apps/gateway
docker build -t ghcr.io/example/cohub-gateway:latest .
docker push ghcr.io/example/cohub-gateway:latest
```

### 2. 配置 Secrets

复制模板并填入真实值：

```bash
cd deploy/gateway/dev  # 或 prod
cp secrets.template.yaml secrets.yaml
# 编辑 secrets.yaml
```

### 3. 部署

```bash
cd deploy/gateway/dev  # 或 prod
chmod +x deploy.sh
./deploy.sh
```

## 环境变量

| 变量名 | 说明 |
|--------|------|
| `REDIS_URL` | Redis 连接地址 |
| `GATEWAY_OUTBOUND_CONCURRENCY` | 节点 outbound 总并发上限，默认 `16`，范围 `1–64`；设为 `1` 可保守降级为串行 |
| `API_BASE_URL` | Cohub API 基础地址，用于鉴权 |
| `POD_NAME` | K8s 自动注入的 Pod 名称 |
| `ENV` | 环境标识 (dev/prod) |
| `DEBUG_MODE` | 调试模式开关 |
| `DEBUG_DISCORD_BOT_TOKEN` | 调试用的 Discord Bot Token |

## Outbound 投递与恢复

- 同会话按 `channelId + externalChatId` 串行，跨会话公平并发。节点总并发默认 16，单 provider 最多 8，媒体最多 4；全局预读上限 256，单会话最多驻留 8 条，其余留在 Redis pending。
- 微信视频仅发送原始 URL；图片保持原生发送，失败时用源 URL 兜底。图片处理预算 45 秒，其他附件 90 秒；发送请求超时 15 秒。
- 命令和会话锁每 15 秒续租，TTL 为 60 秒。发送最多尝试 3 次；provider 未就绪或租约被占用时释放槽位、延迟恢复，不消耗投递次数。已解绑任务先归档，迁移及归档原子校验路由。
- 微信发送前记录 item 进度，已成功部分不重发；媒体准备被取消可以重试，实际发送结果未知则留存待核对，不盲目重发。停机先收尾，25 秒后取消慢请求，未完成任务保留 pending。

失败原文及原因保存在 `stream:gateway:outbound:failed`，写入成功后才移除原任务。`gateway:outbound:progress:<commandId>` 保存逐项进度；成功进度保留 24 小时，失败记录需人工核对后清理。

Outbound 不再按长度裁剪。需监控 Redis 内存、积压年龄、失败记录增长，以及投递日志的 `queueMs`、`durationMs`、`totalMs`。不要裁剪或删除未完成任务；可靠性依赖 Redis 持久化和淘汰策略，不提供 exactly-once 保证。

API 与 gateway 配套灰度发布，避免旧 API 继续裁剪队列或新旧 worker 同时执行迁移任务。可将 `GATEWAY_OUTBOUND_CONCURRENCY` 设为 `1` 保守降级，无需清队列。

## 健康检查端点

- `/healthz` - 存活探针
- `/readyz` - 就绪探针

## Values files

This repository ships `values.example.yaml` only.

```bash
cp values.example.yaml values.yaml
# edit values.yaml for your environment
./deploy.sh
```

Do not commit real `values.yaml` or `secrets.yaml`.

