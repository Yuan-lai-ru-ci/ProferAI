/**
 * Profer 一键发布
 * 用法: node scripts/push-release.js 0.12.70
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VERSION = process.argv[2];
if (!VERSION) { console.error('用法: node scripts/push-release.js <版本号>'); process.exit(1); }

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'apps/electron');
const SERVER = path.join(ROOT, 'server');
const HOST = '47.109.108.57';
const USER = 'ecs-user';
const PASS = 'Aa@cdsqzldt123';
const UPDATE_DIR = '/usr/share/nginx/html/profer-updates';

function ssh(cmd, timeout = 15000) {
  return new Promise((resolve) => {
    const p = spawn('ssh', ['-o', 'StrictHostKeyChecking=no', `${USER}@${HOST}`, cmd]);
    let o = '', e = '';
    p.stdout.on('data', d => o += d);
    p.stderr.on('data', d => e += d);
    p.on('close', () => resolve((o || e).trim()));
    p.stdin.write(PASS + '\n');
    setTimeout(() => { try { p.stdin.write(PASS + '\n') } catch {} }, 800);
    setTimeout(() => { try { p.kill() } catch {} }, timeout);
  });
}

function scp(local, remote) {
  return new Promise((resolve) => {
    const p = spawn('scp', ['-o', 'StrictHostKeyChecking=no', '-q', local, `${USER}@${HOST}:${remote}`]);
    p.on('close', resolve);
    p.stdin.write(PASS + '\n');
    setTimeout(() => { try { p.stdin.write(PASS + '\n') } catch {} }, 800);
    setTimeout(() => { try { p.kill() } catch {} }, 120000);
  });
}

function run(cmd, cwd = ROOT) {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: 'pipe', shell: 'bash' }).trim();
}

(async () => {
  console.log(`=== Profer 发布 v${VERSION} ===\n`);

  // 1. 更新版本号
  console.log('[1/5] 版本号...');
  const pkgPath = path.join(ELECTRON, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = VERSION;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  ${VERSION}`);

  // 2. 推送服务端
  console.log('\n[2/5] 推送服务端...');
  const tmpTar = path.join(SERVER, 'server-rel.tar.gz');
  run('tar -czf server-rel.tar.gz index.js package.json src/', SERVER);
  await scp(tmpTar, '/tmp/server-rel.tar.gz');
  const extract = await ssh('sudo mkdir -p /tmp/srv && sudo tar -xzf /tmp/server-rel.tar.gz -C /tmp/srv && sudo docker cp /tmp/srv/. proma-team:/app/ && sudo rm -rf /tmp/srv && sudo docker restart proma-team && echo OK');
  console.log('  ' + (extract.includes('OK') ? '已推送' : extract.slice(0, 80)));

  // 3. 等容器就绪
  console.log('\n[3/5] 等待容器就绪...');
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const status = await ssh('sudo docker ps --filter name=proma-team --format "{{.Status}}"');
    if (status.includes('healthy')) { console.log('  healthy'); break; }
    if (status.includes('Up') && !status.includes('health')) { console.log('  running (no health check)'); break; }
    console.log(`  retry ${i + 1}: ${status?.slice(0, 30) || 'starting...'}`);
  }

  // 4. 打包 Electron
  console.log('\n[4/5] 打包 Electron...');
  run('npx esbuild src/main/index.ts --bundle --platform=node --format=cjs --outfile=dist/main.cjs --external:electron --external:@anthropic-ai/claude-agent-sdk "--define:__PROFER_BUILD_TARGET__=\'\\\"oss\\\"\'"', ELECTRON);
  const viteOut = run('npx vite build', ELECTRON);
  console.log('  ' + (viteOut.match(/built in [\d.]+s/)?.[0] || 'renderer done'));
  const ebOut = run('npx electron-builder --win --x64', ELECTRON);
  const fileMatch = ebOut.match(/file=(out[^\s]*\.exe)/);
  const installer = fileMatch ? fileMatch[1] : `out/Profer-Setup-${VERSION}.exe`;
  console.log('  ' + installer);

  // 5. 推送自动更新
  console.log('\n[5/5] 推送自动更新...');
  const outDir = path.join(ELECTRON, 'out');
  await scp(path.join(outDir, 'latest.yml'), '/tmp/latest.yml');
  await scp(path.join(outDir, `Profer-Setup-${VERSION}.exe`), `/tmp/Profer-Setup-${VERSION}.exe`);
  const result = await ssh(`sudo mkdir -p ${UPDATE_DIR} && sudo cp /tmp/latest.yml ${UPDATE_DIR}/ && sudo cp /tmp/Profer-Setup-${VERSION}.exe ${UPDATE_DIR}/ && sudo chmod -R 755 ${UPDATE_DIR} && echo OK`);
  console.log('  ' + (result.includes('OK') ? '已推送' : result.slice(0, 80)));

  console.log(`\n=== 发布完成 v${VERSION} ===`);
  console.log(`  安装包: ${installer}`);
  console.log(`  更新源: http://${HOST}/profer-updates/`);

})().catch(e => { console.error('\n发布失败:', e.message); process.exit(1); });
