#!/usr/bin/env bash
#
# deploy-remote.sh — 开发机一键部署（同步 repo server/ → 生产 → 安全部署）
#
# 在开发机执行（Git Bash / WSL / macOS / Linux）：
#   bash server/scripts/deploy-remote.sh          # 先 dry-run，通过后交互确认再正式部署
#   bash server/scripts/deploy-remote.sh --yes     # dry-run 通过后直接部署，不确认
#
# 说明：
#   - 同步 src/Dockerfile/docker-compose.yml/package.json/scripts 到服务器 ~/proma-team-server/
#   - 不同步 .env（服务器专有）、data、backups
#   - 注意：scp 只增量覆盖不删除；若 repo 删过文件，服务器上会残留旧文件（v1 限制，
#     如需精确镜像可改用 rsync --delete）
#
set -euo pipefail

HOST="${PROMA_DEPLOY_HOST:-ecs-user@47.109.108.57}"
REMOTE_DIR="proma-team-server"
HERE="$(cd "$(dirname "$0")/.." && pwd)"   # 定位到 server/ 目录

echo "==> [1/3] 同步代码到 ${HOST}:${REMOTE_DIR}/（不含 .env/data/backups）"
scp -r "$HERE/src" "$HERE/Dockerfile" "$HERE/docker-compose.yml" \
       "$HERE/package.json" "$HERE/index.js" "$HERE/scripts" "${HOST}:${REMOTE_DIR}/"

echo "==> [2/3] 远端 DRY-RUN 预演（临时容器验证新镜像能起来，不碰线上）"
ssh "$HOST" "sed -i 's/\r\$//' ${REMOTE_DIR}/scripts/*.sh; chmod +x ${REMOTE_DIR}/scripts/*.sh; bash ${REMOTE_DIR}/scripts/deploy.sh --dry-run"

if [ "${1:-}" != "--yes" ]; then
  printf "DRY-RUN 通过。正式部署到线上？(y/N) "
  read -r ans
  [ "$ans" = "y" ] || { echo "已取消。"; exit 0; }
fi

echo "==> [3/3] 正式部署"
ssh "$HOST" "bash ${REMOTE_DIR}/scripts/deploy.sh"
echo "==> 完成。"
