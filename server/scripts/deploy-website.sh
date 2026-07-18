#!/usr/bin/env bash
#
# deploy-website.sh — 构建 Astro 官网并部署到两台服务器
#
# 用法（开发机执行）：
#   bash server/scripts/deploy-website.sh
#
# 说明：
#   - 构建 D:\project\astroship-eval（Astro 静态站点）
#   - 同步 dist/ → 47.109.108.57 + 47.108.113.94
#   - 目标路径：/usr/share/nginx/html/profer-site/
#
set -euo pipefail

ASTRO_DIR="${ASTRO_DIR:-D:/project/astroship-eval}"
HOST_MAIN="ecs-user@47.109.108.57"
HOST_WEB="root@47.108.113.94"
REMOTE_PATH="/usr/share/nginx/html/profer-site"

echo "==> [1/3] 构建 Astro 站点..."
cd "$(cygpath -u "$ASTRO_DIR" 2>/dev/null || echo "$ASTRO_DIR")"
npx astro build

echo "==> [2/3] 打包 dist..."
tar -czf /tmp/profer-site.tar.gz -C dist .

echo "==> [3/3] 部署到两台服务器..."
for host in "$HOST_MAIN" "$HOST_WEB"; do
  echo "  → $host"
  scp /tmp/profer-site.tar.gz "${host}:/tmp/"
  ssh "$host" "sudo tar -xzf /tmp/profer-site.tar.gz -C ${REMOTE_PATH}/ && rm /tmp/profer-site.tar.gz"
  echo "  ✓ $host 完成"
done

rm -f /tmp/profer-site.tar.gz
echo "==> 官网部署完成（两台服务器均已同步）"
