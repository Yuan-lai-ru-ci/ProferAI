// Profer 打包脚本（精简版）
// 用法: node scripts/package.cjs 0.14.75
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VER = process.argv[2];
if (!VER) { console.error('用法: node scripts/package.cjs x.x.x'); process.exit(1); }

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'apps/electron');
const OUT = path.join(APP, 'out');
const HOST = '47.109.108.57';
const BASH = 'C:/Program Files/Git/usr/bin/bash.exe';
const UPDATE_DIR = '/usr/share/nginx/html/profer-updates';

function run(cmd, cwd = APP) {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function scpFile(local, remoteName) {
  const src = local.replace(/\\/g, '/').replace(/^([A-Z]):/i, (_, d) => `/${d.toLowerCase()}`);
  execSync(`scp -o StrictHostKeyChecking=no -q '${src}' ecs-user@${HOST}:/tmp/${remoteName}`, {
    encoding: 'utf8', stdio: 'pipe', shell: BASH, timeout: 120_000
  });
}

function ssh(cmd) {
  return execSync(`ssh -o StrictHostKeyChecking=no ecs-user@${HOST} '${cmd}'`, {
    encoding: 'utf8', stdio: 'pipe', shell: BASH, timeout: 30_000
  }).trim();
}

(async () => {
  console.log(`=== Profer ${VER} ===`);

  // 1. 版本号
  const pkgPath = path.join(APP, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = VER;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`[1/3] ${VER}`);

  // 2. 构建
  console.log('[2/3] 构建...');
  const start = Date.now();
  run('npx esbuild src/main/index.ts --bundle --platform=node --format=cjs --outfile=dist/main.cjs --external:electron --external:@anthropic-ai/claude-agent-sdk --external:@earendil-works/pi-coding-agent --external:@earendil-works/pi-agent-core --external:@earendil-works/pi-ai --define:__PROFER_BUILD_TARGET__=\'oss\'');
  run('npx esbuild src/preload/index.ts --bundle --platform=node --format=cjs --outfile=dist/preload.cjs --external:electron');

  // 清理上次残留（防 electron-builder ENOENT）
  try { fs.rmSync(path.join(OUT, 'win-unpacked'), { recursive: true, force: true }); } catch {}

  run('npx vite build');
  run('bun run scripts/build-cli.ts');
  run('bun run scripts/copy-resources.ts');

  // electron-builder 网络可能慢，给 5 分钟
  execSync('npx electron-builder --win --x64', { cwd: APP, encoding: 'utf8', stdio: 'pipe', timeout: 300_000 });
  const exe = `Profer-Setup-${VER}.exe`;
  const exePath = path.join(OUT, exe);
  console.log(`  ${exe}  (${(fs.statSync(exePath).size / 1024 / 1024).toFixed(0)}MB, ${((Date.now()-start)/1000).toFixed(0)}s)`);

  // 3. 上传
  console.log('[3/3] 上传...');
  scpFile(path.join(OUT, 'latest.yml'), 'latest.yml');
  scpFile(exePath, exe);
  // latest.json
  const latestJson = JSON.stringify({ version: VER, installer: exe, size: fs.statSync(exePath).size, date: new Date().toISOString().split('T')[0] });
  const tmpJson = path.join(OUT, 'latest.json');
  fs.writeFileSync(tmpJson, latestJson);
  scpFile(tmpJson, 'latest.json');
  // 服务器端部署
  ssh(`sudo cp /tmp/latest.yml ${UPDATE_DIR}/ && sudo cp /tmp/${exe} ${UPDATE_DIR}/ && sudo cp /tmp/latest.json ${UPDATE_DIR}/ && sudo ln -sf ${UPDATE_DIR}/${exe} ${UPDATE_DIR}/Profer-latest.exe && sudo chmod -R 755 ${UPDATE_DIR} && echo OK`);
  console.log(`  http://${HOST}/profer-updates/`);

  console.log(`\n=== ${VER} 完成 ===`);
})().catch(e => { console.error('\n失败:', e.message?.slice(0, 120) || e); process.exit(1); });
