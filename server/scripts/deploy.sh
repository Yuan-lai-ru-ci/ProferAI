#!/usr/bin/env bash
#
# deploy.sh — Proma Team Server 安全部署（服务器端执行）
#
# 固化 memory/迁移知识包「已验证安全部署流程」，防住三个已知地雷：
#   1) on-disk src 可能半改不可构建（历史上 feedback.js 引用了 db.js 不存在的导出 → crash-loop）
#      → --dry-run 先用临时容器验证新镜像能健康启动，不碰线上。
#   2) compose 是 v1(1.29.2)，有 rebuild bug（KeyError 'ContainerConfig'，旧停新建不出=服务中断）
#      → 先 `docker rm` 旧容器，再 `up -d --no-build`。
#   3) 部署非 git 跟踪、动前常无备份
#      → 部署前强制备份双库 + 打回滚镜像标签 + 健康检查失败自动回滚。
#
# 用法（服务器上，代码已同步到 ~/proma-team-server）：
#   bash ~/proma-team-server/scripts/deploy.sh --dry-run   # 离线预演：只验证新镜像能起来，不动线上
#   bash ~/proma-team-server/scripts/deploy.sh             # 正式部署：备份→回滚标签→build→秒级切换→健康检查→失败自动回滚
#
# 开发机一键触发见同目录 deploy-remote.sh。
#
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-$HOME/proma-team-server}"
CONTAINER="proma-team"
IMAGE="proma-team-server_proma-team"          # compose v1 镜像名 = <project>_<service>
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"        # 健康检查最长等待秒数
DRYRUN_PORT="${DRYRUN_PORT:-13456}"
LOG="${DEPLOY_DIR}/backups/auto/deploy.log"
TS="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$(dirname "$LOG")"
log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }
fail() { log "ERROR: $*"; exit 1; }

cd "$DEPLOY_DIR" || fail "部署目录不存在: $DEPLOY_DIR"
[ -f docker-compose.yml ] || fail "缺 docker-compose.yml，代码是否已同步到 $DEPLOY_DIR ?"

# 兼容 compose v1/v2（本服务器是 v1: docker-compose）
if command -v docker-compose >/dev/null 2>&1; then COMPOSE="docker-compose"; else COMPOSE="docker compose"; fi

# 磁盘保护：低于 2G 拒绝部署（build 会写大量层）
avail_kb="$(df -P / | awk 'NR==2{print $4}')"
[ "$avail_kb" -ge 2097152 ] || fail "磁盘可用不足 2G (${avail_kb}KB)，先清理再部署（docker image prune -f）"

# 等待容器 healthcheck 变 healthy（compose 已定义 /health 检查）
wait_healthy() {
  local name="$1" timeout="$2" waited=0 status
  while [ "$waited" -lt "$timeout" ]; do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealth{{end}}' "$name" 2>/dev/null || echo missing)"
    case "$status" in
      healthy) return 0 ;;
      missing) return 1 ;;
      nohealth)
        if docker exec "$name" node -e 'require("http").get("http://localhost:3456/health",r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))' 2>/dev/null; then return 0; fi ;;
      *)  # starting / unhealthy：若容器已退出则直接失败，否则继续等
        if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || echo false)" != "true" ]; then return 1; fi ;;
    esac
    sleep 3; waited=$((waited+3))
  done
  return 1
}

# ---------- DRY-RUN：只验证新镜像能健康启动，不碰线上 ----------
if [ "${1:-}" = "--dry-run" ]; then
  log "=== DRY-RUN 预演 ${TS} ==="
  log "构建新镜像（旧容器仍在跑）..."
  $COMPOSE build 2>&1 | tee -a "$LOG" || fail "构建失败（on-disk src 可能半改不可构建）"
  TMP_CONTAINER="${CONTAINER}-dryrun"
  TMP_VOL="${CONTAINER}-dryrun-data"
  docker rm -f "$TMP_CONTAINER" >/dev/null 2>&1 || true
  log "临时容器 ${TMP_CONTAINER} 在端口 ${DRYRUN_PORT} 起新镜像（全新空数据卷）..."
  docker run -d --name "$TMP_CONTAINER" --env-file .env -e PORT=3456 \
    -p "${DRYRUN_PORT}:3456" -v "${TMP_VOL}:/app/data" "${IMAGE}:latest" >/dev/null \
    || fail "临时容器启动失败"
  if wait_healthy "$TMP_CONTAINER" "$HEALTH_TIMEOUT"; then
    log "DRY-RUN 通过：新镜像可健康启动"
    docker rm -f "$TMP_CONTAINER" >/dev/null 2>&1 || true
    docker volume rm "$TMP_VOL" >/dev/null 2>&1 || true
    log "=== DRY-RUN 结束（已清理临时容器/卷）==="
    exit 0
  fi
  log "DRY-RUN 失败，新镜像最近日志："
  docker logs --tail 40 "$TMP_CONTAINER" 2>&1 | tee -a "$LOG" || true
  docker rm -f "$TMP_CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$TMP_VOL" >/dev/null 2>&1 || true
  fail "DRY-RUN 未通过，已中止（线上未受影响）"
fi

# ---------- 正式部署 ----------
log "=== 部署开始 ${TS} ==="

# 1. 动前强制备份双库
if [ -x "${DEPLOY_DIR}/scripts/backup-dbs.sh" ]; then
  log "部署前备份双库..."
  bash "${DEPLOY_DIR}/scripts/backup-dbs.sh" || fail "部署前备份失败，中止"
else
  log "警告: 未找到可执行的 backup-dbs.sh，跳过自动备份（强烈建议先装）"
fi

# 2. build 前打回滚镜像标签（锁定当前线上镜像 SHA）
ROLLBACK_TAG="${IMAGE}:rollback-${TS}"
CUR_IMG="$(docker inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null || true)"
if [ -n "$CUR_IMG" ]; then
  docker tag "$CUR_IMG" "$ROLLBACK_TAG"
  log "已打回滚标签: ${ROLLBACK_TAG}"
else
  log "警告: 当前无运行中的 ${CONTAINER}，无回滚标签（首次部署?）"
fi

# 3. 构建新镜像（旧容器仍跑，不中断）
log "构建新镜像..."
$COMPOSE build 2>&1 | tee -a "$LOG" || fail "构建失败，线上未动"

# 4. 秒级切换：先 rm 旧容器绕过 compose v1 rebuild bug，再 up --no-build
log "切换容器（rm 旧 → up 新，绕过 compose v1 KeyError bug）..."
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
$COMPOSE up -d --no-build 2>&1 | tee -a "$LOG" || fail "启动新容器失败"

# 5. 健康检查
log "健康检查（最长 ${HEALTH_TIMEOUT}s）..."
if wait_healthy "$CONTAINER" "$HEALTH_TIMEOUT"; then
  log "部署成功，${CONTAINER} 健康"
  log "=== 部署完成 ${TS} ==="
  exit 0
fi

# 6. 失败自动回滚
log "新容器未通过健康检查，自动回滚..."
docker logs --tail 40 "$CONTAINER" 2>&1 | tee -a "$LOG" || true
[ -n "$CUR_IMG" ] || fail "新容器不健康且无回滚镜像，需人工介入"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker tag "$ROLLBACK_TAG" "${IMAGE}:latest"
$COMPOSE up -d --no-build 2>&1 | tee -a "$LOG" || fail "回滚启动失败！需人工介入（回滚标签 ${ROLLBACK_TAG}）"
if wait_healthy "$CONTAINER" "$HEALTH_TIMEOUT"; then
  log "已回滚到部署前镜像，${CONTAINER} 恢复健康"
  fail "部署失败但已成功回滚（线上恢复，请排查新镜像）"
fi
fail "回滚后仍不健康！需人工介入（回滚标签 ${ROLLBACK_TAG}）"
