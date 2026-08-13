/**
 * Profer 一键发布（安全版）
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
 * 安全: 使用 SSH 密钥认证，不再硬编码密码。
 * 本机缺 gh CLI 时通道二自动跳过, 不影响已完成的通道一。
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VERSION = process.argv[2];
if (!VERSION) { console.error('用法: node scripts/push-release.js <版本号>'); process.exit(1); }

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'apps/electron');
const HOST = '47.109.108.57';
const USER = 'ecs-user';
const UPDATE_DIR = '/usr/share/nginx/html/profer-updates';
const TAG = `v${VERSION}`;
const GH_REPO = 'Yuan-lai-ru-ci/ProferAI';
// 使用 Git Bash（能访问 Windows 文件系统 + SSH 密钥），不用 WSL bash
const BASH = 'C:/Program Files/Git/usr/bin/bash.exe';

function ssh(cmd, timeout = 30000) {
  return new Promise((resolve) => {
    const p = spawn(BASH, ['-c', `ssh -o StrictHostKeyChecking=no ${USER}@${HOST} '${cmd.replace(/'/g, "'\\''")}'`]);
    let o = '', e = '';
    p.stdout.on('data', d => o += d);
    p.stderr.on('data', d => e += d);
    p.on('close', () => resolve((o || e).trim()));
    setTimeout(() => { try { p.kill() } catch {} }, timeout);
  });
}

function scp(local, remote) {
  return new Promise((resolve, reject) => {
    const src = local.replace(/\\/g, '/');
    const p = spawn(BASH, ['-c', `scp -o StrictHostKeyChecking=no -q '${src.replace(/'/g, "'\\''")}' ${USER}@${HOST}:${remote}`]);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`scp ${local} → ${remote} 失败 (exit ${code})`)));
    setTimeout(() => { try { p.kill() } catch {} }, 600000); // 10min，大文件够用
  });
}

// Windows 原生命令（npx / bun / node / git）
function run(cmd, cwd = ROOT) {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

// Git Bash 命令（tar / scp / ssh 等需要 Unix 工具的命令）
function runBash(cmd, cwd = ROOT) {
  const wslCwd = cwd.replace(/\\/g, '/').replace(/^([A-Z]):/i, (_, d) => `/${d.toLowerCase()}`);
  return execSync(`cd '${wslCwd}' && PATH="/usr/bin:$PATH" ${cmd}`, { encoding: 'utf8', stdio: 'pipe', shell: BASH }).trim();
}

function tryRun(cmd, cwd = ROOT) {
  try { return { ok: true, out: execSync(cmd, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim() }; }
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

  // 2. 完整构建 + 打包 Electron
  console.log('\n[2/4] 打包 Electron...');
  console.log('  [2a] build:main');
  run("npx esbuild src/main/index.ts --bundle --platform=node --format=cjs --outfile=dist/main.cjs --external:electron --external:@anthropic-ai/claude-agent-sdk --external:@earendil-works/pi-coding-agent --external:@earendil-works/pi-agent-core --external:@earendil-works/pi-ai --define:__PROFER_BUILD_TARGET__='oss'", ELECTRON);
  console.log('  [2b] build:preload');
  run('npx esbuild src/preload/index.ts --bundle --platform=node --format=cjs --outfile=dist/preload.cjs --external:electron', ELECTRON);
  console.log('  [2c] build:renderer (vite)');
  const viteOut = run('npx vite build', ELECTRON);
  console.log('    ' + (viteOut.match(/built in [\d.]+s/)?.[0] || 'OK'));
  console.log('  [2d] build:cli');
  run('bun run scripts/build-cli.ts', ELECTRON);
  console.log('  [2e] build:resources');
  run('bun run scripts/copy-resources.ts', ELECTRON);
  console.log('  [2f] electron-builder --win --x64');
  const ebOut = run('npx electron-builder --win --x64', ELECTRON);
  const fileMatch = ebOut.match(/file=(out[^\s]*\.exe)/);
  const installer = fileMatch ? fileMatch[1] : `out/Profer-Setup-${VERSION}.exe`;
  console.log('  ' + installer);

  // 3. 上传安装包 (通道一: 自动更新)
  console.log('\n[3/4] 上传安装包 (通道一: profer-updates)...');
  const outDir = path.join(ELECTRON, 'out');
  const installerPath = path.join(outDir, `Profer-Setup-${VERSION}.exe`);
  const installerSize = fs.statSync(installerPath).size;
  await scp(path.join(outDir, 'latest.yml'), '/tmp/latest.yml');
  await scp(installerPath, `/tmp/Profer-Setup-${VERSION}.exe`);

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
    `echo OK`,
    120000  // 大文件 cp 可能需要几十秒
  );
  console.log('  ' + (result.includes('OK') ? '已推送' : result.slice(0, 80)));

  // 4. GitHub Release (通道二)
  console.log('\n[4/4] GitHub Release (通道二)...');
  const assets = ['latest.yml', `Profer-Setup-${VERSION}.exe`, `Profer-Setup-${VERSION}.exe.blockmap`]
    .map(f => path.join(outDir, f)).filter(f => fs.existsSync(f));

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const ghExe = '"C:/Program Files/GitHub CLI/gh.exe"';
  if (!GITHUB_TOKEN) {
    console.log('  ⚠ 跳过: 未设置 GITHUB_TOKEN 环境变量 (通道一已成功, 不影响自动更新)。');
    console.log('    设置后重跑本步即可上传 GitHub:');
    console.log('      export GITHUB_TOKEN=ghp_xxxx');
  } else {
    tryRun(`git add "${pkgPath}"`, ROOT);
    const commit = tryRun(`git commit -m "chore: release ${TAG} [auto-release]"`, ROOT);
    console.log('  commit: ' + (commit.ok ? 'ok' : '跳过(无版本号变更)'));

    // push 前先 pull --rebase 防冲突
    tryRun(`git pull --rebase origin main`, ROOT);
    tryRun(`git tag -f ${TAG}`, ROOT);
    const push = tryRun(`git push origin HEAD && git push origin -f ${TAG}`, ROOT);
    console.log('  push: ' + (push.ok ? 'ok' : push.out.slice(-160)));

    const notesFile = path.join(ROOT, 'release-notes', `${TAG}.md`);
    const notesArg = fs.existsSync(notesFile)
      ? `--notes-file "${notesFile}"`
      : `--notes "Profer ${TAG}"`;

    // 先注入环境变量（Windows cmd 不认 export 前缀，直接 set process.env）
    process.env.GITHUB_TOKEN = GITHUB_TOKEN
    // 先创建 draft（不带资产）
    let rel = tryRun(`${ghExe} release create ${TAG} --repo ${GH_REPO} --title "${TAG}" ${notesArg} --draft`, ROOT);
    if (!rel.ok && /already exists|already_exists|HTTP 422/i.test(rel.out)) {
      rel = { ok: true, out: '' };
    }
    if (rel.ok) {
      // 逐个上传资产
      for (const a of assets) {
        const name = path.basename(a);
        const up = tryRun(`${ghExe} release upload ${TAG} "${a}" --repo ${GH_REPO}`, ROOT);
        console.log(`    ${name}: ${up.ok ? 'ok' : up.out.slice(-80)}`);
      }
      // 发布 draft
      const pub = tryRun(`${ghExe} release edit ${TAG} --repo ${GH_REPO} --draft=false`, ROOT);
      console.log('  publish: ' + (pub.ok ? 'ok' : pub.out.slice(-80)));
    } else {
      console.log('  release: ' + rel.out.slice(-200));
    }
  }

  console.log(`\n=== 发布完成 v${VERSION} ===`);
  console.log(`  安装包:            ${installer}`);
  console.log(`  通道一(自动更新):  http://${HOST}/profer-updates/`);
  console.log(`  通道二(GitHub):    https://github.com/${GH_REPO}/releases/tag/${TAG}`);

})().catch(e => { console.error('\n发布失败:', e.message); process.exit(1); });
