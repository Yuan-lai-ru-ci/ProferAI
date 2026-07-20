#!/bin/bash
# Profer 一键发布脚本
# 用法: ./scripts/push-release.sh 0.12.70
# 参数: 版本号（必填）
#
# 流程:
#  1. 更新版本号
#  2. 推送服务端代码到生产
#  3. 打包 Electron 安装包
#  4. 上传更新文件到自动更新服务器

set -e

VERSION="${1:?请指定版本号，如 0.12.70}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON_DIR="$ROOT/apps/electron"
SERVER_DIR="$ROOT/server"
PROD_HOST="47.109.108.57"
PROD_USER="ecs-user"
SSH_PASS="Aa@cdsqzldt123"
UPDATE_DIR="/usr/share/nginx/html/profer-updates"

echo "╔══════════════════════════════════════╗"
echo "║  Profer 发布 v${VERSION}"
echo "╚══════════════════════════════════════╝"

# 1. 更新版本号
echo ""
echo "[1/4] 更新版本号..."
cd "$ELECTRON_DIR"
CURRENT=$(node -e "console.log(require('./package.json').version)")
sed -i "s/\"version\": \"$CURRENT\"/\"version\": \"$VERSION\"/" package.json
echo "  $CURRENT → $VERSION"

# 2. 推送服务端
echo ""
echo "[2/4] 推送服务端..."
cd "$SERVER_DIR"
tar -czf /tmp/server-release.tar.gz index.js package.json src/ 2>/dev/null

node -e "
const { spawn } = require('child_process');
const { stdin } = require('process');

function scpFile(local, remote) {
  return new Promise(r => {
    const p = spawn('scp', ['-o','StrictHostKeyChecking=no','-q', local, remote]);
    p.on('close', r);
    p.stdin.write('$SSH_PASS\n');
    setTimeout(() => p.stdin.write('$SSH_PASS\n'), 800);
    setTimeout(() => p.kill(), 30000);
  });
}
function sh(cmd) {
  return new Promise(r => {
    const p = spawn('ssh', ['-o','StrictHostKeyChecking=no', '$PROD_USER@$PROD_HOST', cmd]);
    let o = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => o += d);
    p.on('close', () => r(o.trim()));
    p.stdin.write('$SSH_PASS\n');
    setTimeout(() => p.stdin.write('$SSH_PASS\n'), 800);
    setTimeout(() => p.kill(), 15000);
  });
}
(async() => {
  try {
    await scpFile('/tmp/server-release.tar.gz', '$PROD_USER@$PROD_HOST:/tmp/server-release.tar.gz');
    const extract = await sh('sudo tar -xzf /tmp/server-release.tar.gz -C /tmp/server-tmp && sudo docker cp /tmp/server-tmp/. proma-team:/app/ && sudo rm -rf /tmp/server-tmp');
    console.log('服务端文件已推送');
    const restart = await sh('sudo docker restart proma-team');
    console.log('容器重启中...');
    // Wait for healthy
    await new Promise(r => setTimeout(r, 5000));
    const health = await sh('sudo docker ps --filter name=proma-team --format \"{{.Status}}\"');
    console.log('状态:', health);
  } catch(e) {
    console.error('推送失败:', e.message);
    process.exit(1);
  }
})();
"

# 3. 打包 Electron
echo ""
echo "[3/4] 打包 Electron..."
cd "$ELECTRON_DIR"
echo "  构建 main..."
npx esbuild src/main/index.ts --bundle --platform=node --format=cjs --outfile=dist/main.cjs --external:electron --external:@anthropic-ai/claude-agent-sdk "--define:__PROFER_BUILD_TARGET__='\"oss\"'" 2>&1 | tail -1
echo "  构建 renderer..."
npx vite build 2>&1 | grep "built"
echo "  打包 NSIS..."
npx electron-builder --win --x64 2>&1 | grep -E "file=|afterPack"

# 4. 推送自动更新
echo ""
echo "[4/4] 推送自动更新..."
cp "$ELECTRON_DIR/out/latest.yml" /tmp/
cp "$ELECTRON_DIR/out/Profer-Setup-${VERSION}.exe" /tmp/
cp "$ELECTRON_DIR/out/Profer-Setup-${VERSION}.exe.blockmap" /tmp/ 2>/dev/null || true

node -e "
const { spawn } = require('child_process');
function scpFile(local, remote) {
  return new Promise(r => {
    const p = spawn('scp', ['-o','StrictHostKeyChecking=no','-q', local, remote]);
    p.on('close', r);
    p.stdin.write('$SSH_PASS\n');
    setTimeout(() => p.stdin.write('$SSH_PASS\n'), 800);
    setTimeout(() => p.kill(), 120000);
  });
}
function sh(cmd) {
  return new Promise(r => {
    const p = spawn('ssh', ['-o','StrictHostKeyChecking=no', '$PROD_USER@$PROD_HOST', cmd]);
    let o = ''; p.stdout.on('data', d => o += d);
    p.on('close', () => r(o.trim()));
    p.stdin.write('$SSH_PASS\n');
    setTimeout(() => p.stdin.write('$SSH_PASS\n'), 800);
    setTimeout(() => p.kill(), 10000);
  });
}
(async() => {
  try {
    await sh('mkdir -p /tmp/profer-updates');
    await scpFile('/tmp/latest.yml', '$PROD_USER@$PROD_HOST:/tmp/profer-updates/latest.yml');
    await scpFile('/tmp/Profer-Setup-${VERSION}.exe', '$PROD_USER@$PROD_HOST:/tmp/profer-updates/Profer-Setup-${VERSION}.exe');
    const result = await sh('sudo mkdir -p $UPDATE_DIR && sudo cp /tmp/profer-updates/* $UPDATE_DIR/ && sudo chmod -R 755 $UPDATE_DIR && echo OK');
    console.log('更新推送:', result);
  } catch(e) {
    console.error('推送失败:', e.message);
    process.exit(1);
  }
})();
"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  发布完成 v${VERSION}"
echo "║  安装包: out/Profer-Setup-${VERSION}.exe"
echo "║  更新源: http://${PROD_HOST}/profer-updates/"
echo "╚══════════════════════════════════════╝"
