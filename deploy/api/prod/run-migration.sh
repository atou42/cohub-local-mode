#!/bin/bash
# 数据库迁移 Job
# 用法: ./run-migration.sh [options] [IMAGE_TAG]
#
# 选项:
#   -f, --force     强制重新运行（删除已存在的 job）
#   -s, --status    查看最近一次 migration 状态
#   -l, --logs      查看最近一次 migration 日志
#   -h, --help      显示帮助

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFESTS_DIR="$SCRIPT_DIR/../manifests"

get_value() {
  local key="$1"
  grep -E "^${key}:" "$SCRIPT_DIR/values.yaml" | head -1 | sed 's/^[^:]*:[[:space:]]*//' | sed 's/^"//' | sed 's/"$//'
}

NAMESPACE=$(get_value "NAMESPACE")
APP_NAME=$(get_value "APP_NAME")
IMAGE_REPOSITORY=$(get_value "IMAGE_REPOSITORY")
IMAGE_TAG=""
IMAGE_PULL_POLICY=$(get_value "IMAGE_PULL_POLICY")
IMAGE_PULL_SECRET=$(get_value "IMAGE_PULL_SECRET")
FORCE=false

# 解析参数
while [[ $# -gt 0 ]]; do
  case $1 in
    -f|--force)
      FORCE=true
      shift
      ;;
    -s|--status)
      echo -e "${BLUE}Migration 状态:${NC}"
      kubectl get job "${APP_NAME}-migrate" -n "$NAMESPACE" -o wide 2>/dev/null || echo -e "${YELLOW}没有找到 migration job${NC}"
      echo ""
      echo "Pod 状态:"
      kubectl get pods -n "$NAMESPACE" -l "app.kubernetes.io/name=${APP_NAME}-migrate" 2>/dev/null || echo "无运行中的 pod"
      exit 0
      ;;
    -l|--logs)
      echo -e "${BLUE}Migration 日志:${NC}"
      kubectl logs job/${APP_NAME}-migrate -n "$NAMESPACE" --tail=100 2>/dev/null || echo -e "${YELLOW}没有找到 migration job 或没有日志${NC}"
      exit 0
      ;;
    -h|--help)
      echo "数据库迁移工具"
      echo ""
      echo "用法:"
      echo "  $0 [options] [IMAGE_TAG]"
      echo ""
      echo "选项:"
      echo "  -f, --force     强制重新运行（删除已存在的 job）"
      echo "  -s, --status    查看最近一次 migration 状态"
      echo "  -l, --logs      查看最近一次 migration 日志"
      echo "  -h, --help      显示帮助"
      echo ""
      echo "示例:"
      echo "  $0                    # 使用 values.yaml 中的 IMAGE_TAG 运行"
      echo "  $0 v1.2.3            # 使用指定镜像 tag"
      echo "  $0 -f                # 强制重新运行"
      echo "  $0 -s                # 查看状态"
      exit 0
      ;;
    -*)
      echo -e "${RED}错误: 未知选项 $1${NC}"
      echo "使用 -h 查看帮助"
      exit 1
      ;;
    *)
      IMAGE_TAG="$1"
      shift
      ;;
  esac
done

# 如果没有指定 tag，从 values.yaml 读取
if [[ -z "$IMAGE_TAG" ]]; then
  IMAGE_TAG=$(get_value "IMAGE_TAG")
fi

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Prod Database Migration Job         ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "Namespace: ${YELLOW}${NAMESPACE}${NC}"
echo -e "Image: ${YELLOW}${IMAGE_REPOSITORY}:${IMAGE_TAG}${NC}"
echo ""

# 检查是否已存在 job
if kubectl get job "${APP_NAME}-migrate" -n "$NAMESPACE" &>/dev/null; then
  if [[ "$FORCE" == "true" ]]; then
    echo -e "${YELLOW}删除已存在的 migration job...${NC}"
    kubectl delete job "${APP_NAME}-migrate" -n "$NAMESPACE"
  else
    echo -e "${YELLOW}⚠️  Migration job 已存在${NC}"
    echo ""
    echo "状态:"
    kubectl get job "${APP_NAME}-migrate" -n "$NAMESPACE" -o wide
    echo ""
    echo "使用 -f 强制重新运行，或使用 -l 查看日志"
    exit 1
  fi
fi

# 渲染 Job 模板
echo -e "${BLUE}创建 migration job...${NC}"
mkdir -p "$SCRIPT_DIR/rendered"

# 使用 sed 替换模板变量
sed \
  -e "s|__NAMESPACE__|${NAMESPACE}|g" \
  -e "s|__APP_NAME__|${APP_NAME}|g" \
  -e "s|__IMAGE_REPOSITORY__|${IMAGE_REPOSITORY}|g" \
  -e "s|__IMAGE_TAG__|${IMAGE_TAG}|g" \
  -e "s|__IMAGE_PULL_POLICY__|${IMAGE_PULL_POLICY}|g" \
  "$MANIFESTS_DIR/migration-job.tmpl.yaml" > "$SCRIPT_DIR/rendered/migration-job.yaml"

# 添加 imagePullSecrets 如果配置了
if [[ -n "$IMAGE_PULL_SECRET" ]]; then
  # 在 containers 之前插入 imagePullSecrets
  python3 -c "
import sys
with open('$SCRIPT_DIR/rendered/migration-job.yaml', 'r') as f:
    content = f.read()
content = content.replace(
    '      containers:',
    '      imagePullSecrets:\n        - name: ${IMAGE_PULL_SECRET}\n      containers:'
)
with open('$SCRIPT_DIR/rendered/migration-job.yaml', 'w') as f:
    f.write(content)
"
fi

# 创建 Job
kubectl apply -f "$SCRIPT_DIR/rendered/migration-job.yaml"

echo ""
echo -e "${YELLOW}等待 Migration Job 完成...${NC}"
echo ""

# 等待 Job 完成，同时显示进度
if kubectl wait --for=condition=complete "job/${APP_NAME}-migrate" -n "$NAMESPACE" --timeout=660s; then
  echo ""
  echo -e "${GREEN}✅ Migration 完成${NC}"
  echo ""
  
  # 显示成功日志
  echo -e "${BLUE}Migration 日志:${NC}"
  kubectl logs "job/${APP_NAME}-migrate" -n "$NAMESPACE"
else
  echo ""
  echo -e "${RED}❌ Migration 失败${NC}"
  echo ""
  echo "查看日志:"
  echo "  kubectl logs job/${APP_NAME}-migrate -n ${NAMESPACE}"
  echo ""
  echo "状态:"
  kubectl get job "${APP_NAME}-migrate" -n "$NAMESPACE" -o wide
  exit 1
fi

# 显示 Job 状态
echo ""
echo -e "${BLUE}Job 状态:${NC}"
kubectl get job "${APP_NAME}-migrate" -n "$NAMESPACE" -o wide

echo ""
echo -e "${GREEN}✅ 数据库 Migration 完成${NC}"
echo ""
echo "查看日志:"
echo "  $0 -l"
echo "查看状态:"
echo "  $0 -s"
