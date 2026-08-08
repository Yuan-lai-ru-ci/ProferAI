/**
 * Profer 手动发版脚本（按需发版，替代旧的每次 push 自动 bump）
 *
 * 用法:
 *   node scripts/tag-release.cjs 0.15.26
 *
 * 流程:
 *   [1] 校验并写入新版本号到 apps/electron/package.json
 *   [2] bun install --lockfile-only 同步 bun.lock（workspace 元数据）
 *   [3] commit "release: vX.Y.Z"
 *   [4] 打 annotated tag vX.Y.Z
 *   [5] push origin main + push origin vX.Y.Z → 触发 release.yml 自动构建发布
 *
 * 说明:
 *   - 平时 push 代码到 main 不会再自动发版（auto-version.yml 已移除）
 *   - 只有显式运行本脚本（或手动打 tag）才会发布
 *   - tag 版本必须与 apps/electron/package.json 一致，release.yml 会校验
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VERSION = process.argv[2];
if (!VERSION) { console.error('用法: node scripts/tag-release.cjs <版本号>'); process.exit(1); }
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) {
  console.error(`版本号格式错误: ${VERSION}（应为 x.y.z，如 0.15.26）`);
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'apps', 'electron', 'package.json');
const TAG = `v${VERSION}`;

function run(cmd, cwd = ROOT) {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function tryRun(cmd, cwd = ROOT) {
  try { return { ok: true, out: execSync(cmd, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim() }; }
  catch (e) { return { ok: false, out: ((e.stdout || '') + (e.stderr || '') || e.message || '').trim() }; }
}

try {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const current = pkg.version;

  if (current === VERSION) {
    console.error(`当前版本已是 ${VERSION}，无需重复发版`);
    process.exit(1);
  }
  console.log(`=== Profer 发版 ${current} → ${VERSION} ===\n`);

  // [1] 写入新版本号
  console.log('[1/5] bump 版本号...');
  pkg.version = VERSION;
  fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  apps/electron/package.json: ${current} → ${VERSION}`);

  // [2] 同步 bun.lock（workspace 包元数据含版本号，frozen-lockfile 会校验）
  console.log('[2/5] 同步 lockfile...');
  const lock = tryRun('bun install --lockfile-only');
  if (!lock.ok) { console.error('  bun install 失败:\n' + lock.out.slice(-800)); process.exit(1); }
  console.log('  bun.lock 已同步');

  // [3] commit
  console.log('[3/5] commit...');
  const commit = tryRun(`git add apps/electron/package.json bun.lock && git commit -m "release: ${TAG}"`);
  if (!commit.ok) {
    // 可能是"nothing to commit"，不太可能发生（版本已变更），打印出来人工判断
    console.log('  ' + (commit.out.split('\n')[0] || 'ok'));
  } else {
    console.log('  ' + (commit.out.split('\n')[0] || 'ok'));
  }

  // [4] 打 tag
  console.log('[4/5] tag...');
  const tag = tryRun(`git tag -a ${TAG} -m "Profer ${TAG}"`);
  if (!tag.ok && !/already exists/i.test(tag.out)) {
    console.error('  打 tag 失败:\n' + tag.out.slice(-400));
    process.exit(1);
  }
  console.log(`  ${TAG} 已创建`);

  // [5] push（先 pull --rebase 防冲突；tag 已存在时允许 -f 覆盖重推）
  console.log('[5/5] push...');
  tryRun('git pull --rebase origin main');
  const pushMain = tryRun('git push origin HEAD');
  console.log('  push main: ' + (pushMain.ok ? 'ok' : pushMain.out.slice(-200)));
  const pushTag = tryRun(`git push origin -f ${TAG}`);
  console.log(`  push ${TAG}: ` + (pushTag.ok ? 'ok' : pushTag.out.slice(-200)));

  if (!pushTag.ok) {
    console.log('\n⚠ push tag 失败，可检查远端权限后重试:');
    console.log(`  git push origin -f ${TAG}`);
    process.exit(1);
  }

  console.log(`\n=== 发版完成 ${TAG} ===`);
  console.log(`  release.yml 将自动构建 Windows 安装包并发布到 GitHub Releases`);
  console.log(`  进度: https://github.com/Yuan-lai-ru-ci/ProferAI/actions`);
} catch (e) {
  console.error('\n发版失败:', e.message);
  process.exit(1);
}
