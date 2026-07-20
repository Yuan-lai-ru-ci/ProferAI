/**
 * Profer 一键发布
 * 用法: node scripts/push-release.js 0.12.70
 *
 * 流程:
 *  [1] bump 版本号
 *  [2] 推送服务端到生产 proma-team
 *  [3] 等容器就绪
 *  [4] 打包 Electron (NSIS)
 *  [5] 推送自动更新   —— 通道一: 国内 profer-updates 静态源
 *  [6] 更新 GitHub    —— 通道二: commit + tag + Release 资产 (需本机 gh CLI 已登录)
 *
 * 注: 第 6 步只做 GitHub 公开发布(通道二), 不改打包方式, 不碰 auto-updater。
 *     本机缺 gh CLI 时该步自动跳过, 不影响已完成的通道一。
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
const TAG = `v${VERSION}`;
const GH_REPO = 'Yuan-lai-ru-ci/Profer';

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

// 执行但不抛异常, 返回 { ok, out } —— 用于 GitHub 步骤, 失败不拖垮已完成的通道一
function tryRun(cmd, cwd = ROOT) {
  try { return { ok: true, out: execSync(cmd, { cwd, encoding: 'utf8', stdio: 'pipe', shell: 'bash' }).trim() }; }
  catch (e) { return { ok: false, out: ((e.stdout || '') + (e.stderr || '') || e.message || '').trim() }; }
}

(async () => {
  console.log(`=== Profer 发布 v${VERSION} ===\n`);

  // 1. 更新版本号
  console.log('[1/6] 版本号...');
  const pkgPath = path.join(ELECTRON, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = VERSION;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  ${VERSION}`);

  // 2. 推送服务端
  console.log('\n[2/6] 推送服务端...');
  const tmpTar = path.join(SERVER, 'server-rel.tar.gz');
  run('tar -czf server-rel.tar.gz index.js package.json src/', SERVER);
  await scp(tmpTar, '/tmp/server-rel.tar.gz');
  const extract = await ssh('sudo mkdir -p /tmp/srv && sudo tar -xzf /tmp/server-rel.tar.gz -C /tmp/srv && sudo docker cp /tmp/srv/. proma-team:/app/ && sudo rm -rf /tmp/srv && sudo docker restart proma-team && echo OK');
  console.log('  ' + (extract.includes('OK') ? '已推送' : extract.slice(0, 80)));

  // 3. 等容器就绪
  console.log('\n[3/6] 等待容器就绪...');
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const status = await ssh('sudo docker ps --filter name=proma-team --format "{{.Status}}"');
    if (status.includes('healthy')) { console.log('  healthy'); break; }
    if (status.includes('Up') && !status.includes('health')) { console.log('  running (no health check)'); break; }
    console.log(`  retry ${i + 1}: ${status?.slice(0, 30) || 'starting...'}`);
  }

  // 4. 完整构建 + 打包 Electron
  console.log('\n[4/6] 打包 Electron...');
  console.log('  [4a] build:main');
  run('npx esbuild src/main/index.ts --bundle --platform=node --format=cjs --outfile=dist/main.cjs --external:electron --external:@anthropic-ai/claude-agent-sdk --external:@earendil-works/pi-coding-agent --external:@earendil-works/pi-agent-core --external:@earendil-works/pi-ai "--define:__PROFER_BUILD_TARGET__=\'\\\"oss\\\"\'"', ELECTRON);
  console.log('  [4b] build:preload');
  run('npx esbuild src/preload/index.ts --bundle --platform=node --format=cjs --outfile=dist/preload.cjs --external:electron', ELECTRON);
  console.log('  [4c] build:renderer (vite)');
  const viteOut = run('npx vite build', ELECTRON);
  console.log('    ' + (viteOut.match(/built in [\d.]+s/)?.[0] || 'OK'));
  console.log('  [4d] build:cli');
  run('bun run scripts/build-cli.ts', ELECTRON);
  console.log('  [4e] build:resources');
  run('bun run scripts/copy-resources.ts', ELECTRON);
  console.log('  [4f] sync:runtime-deps');
  run('bun run sync:runtime-deps', ELECTRON);
  console.log('  [4g] electron-builder --win --x64');
  const ebOut = run('npx electron-builder --win --x64', ELECTRON);
  const fileMatch = ebOut.match(/file=(out[^\s]*\.exe)/);
  const installer = fileMatch ? fileMatch[1] : `out/Profer-Setup-${VERSION}.exe`;
  console.log('  ' + installer);

  // 5. 推送自动更新 (通道一)
  console.log('\n[5/6] 推送自动更新 (通道一: profer-updates)...');
  const outDir = path.join(ELECTRON, 'out');
  const installerPath = path.join(outDir, `Profer-Setup-${VERSION}.exe`);
  const installerSize = fs.statSync(installerPath).size;
  await scp(path.join(outDir, 'latest.yml'), '/tmp/latest.yml');
  await scp(installerPath, `/tmp/Profer-Setup-${VERSION}.exe`);

  // 生成 latest.json（供官网动态读取版本号）
  const latestJson = JSON.stringify({
    version: VERSION,
    installer: `Profer-Setup-${VERSION}.exe`,
    size: installerSize,
    date: new Date().toISOString().split('T')[0],
  });
  const tmpJson = path.join(outDir, 'latest.json');
  fs.writeFileSync(tmpJson, latestJson);
  await scp(tmpJson, '/tmp/latest.json');

  const result = await ssh(
    `sudo mkdir -p ${UPDATE_DIR} && ` +
    `sudo cp /tmp/latest.yml ${UPDATE_DIR}/ && ` +
    `sudo cp /tmp/Profer-Setup-${VERSION}.exe ${UPDATE_DIR}/ && ` +
    `sudo cp /tmp/latest.json ${UPDATE_DIR}/ && ` +
    `sudo ln -sf ${UPDATE_DIR}/Profer-Setup-${VERSION}.exe ${UPDATE_DIR}/Profer-latest.exe && ` +
    `sudo chmod -R 755 ${UPDATE_DIR} && ` +
    `echo OK`
  );
  console.log('  ' + (result.includes('OK') ? '已推送' : result.slice(0, 80)));

  // 6. 更新 GitHub (通道二: 公开 AGPL 发布)
  console.log('\n[6/6] 更新 GitHub (通道二: git tag + Release)...');
  const assets = ['latest.yml', `Profer-Setup-${VERSION}.exe`, `Profer-Setup-${VERSION}.exe.blockmap`]
    .map(f => path.join(outDir, f)).filter(f => fs.existsSync(f));

  if (!tryRun('gh --version').ok) {
    console.log('  ⚠ 跳过: 未检测到 gh CLI (通道一已成功, 不影响自动更新)。');
    console.log('    一次性配置后重跑本步即可上传 GitHub:');
    console.log('      winget install --id GitHub.cli   # 安装');
    console.log('      gh auth login                    # 浏览器授权');
  } else {
    // 6.1 提交版本号 bump (只 add package.json, 不动其它工作树改动)
    tryRun(`git add "${pkgPath}"`, ROOT);
    const commit = tryRun(`git commit -m "chore: release ${TAG}"`, ROOT);
    console.log('  commit: ' + (commit.ok ? 'ok' : '跳过(无版本号变更)'));

    // 6.2 打 tag (-f 幂等) 并推送当前分支 + tag
    tryRun(`git tag -f ${TAG}`, ROOT);
    const push = tryRun(`git push origin HEAD && git push origin -f ${TAG}`, ROOT);
    console.log('  push: ' + (push.ok ? 'ok' : push.out.slice(-160)));

    // 6.3 创建 Release 并上传资产 (已存在则覆盖上传)
    const notesFile = path.join(ROOT, 'release-notes', `${TAG}.md`);
    const notesArg = fs.existsSync(notesFile)
      ? `--notes-file "${notesFile}"`
      : `--notes "Profer ${TAG}"`;
    const assetsArg = assets.map(a => `"${a}"`).join(' ');
    let rel = tryRun(`gh release create ${TAG} ${assetsArg} --repo ${GH_REPO} --title "${TAG}" ${notesArg}`, ROOT);
    if (!rel.ok && /already exists|already_exists|HTTP 422/i.test(rel.out)) {
      rel = tryRun(`gh release upload ${TAG} ${assetsArg} --repo ${GH_REPO} --clobber`, ROOT);
    }
    console.log('  release: ' + (rel.ok ? 'ok' : rel.out.slice(-200)));
  }

  console.log(`\n=== 发布完成 v${VERSION} ===`);
  console.log(`  安装包:            ${installer}`);
  console.log(`  通道一(自动更新):  http://${HOST}/profer-updates/`);
  console.log(`  通道二(GitHub):    https://github.com/${GH_REPO}/releases/tag/${TAG}`);

})().catch(e => { console.error('\n发布失败:', e.message); process.exit(1); });
