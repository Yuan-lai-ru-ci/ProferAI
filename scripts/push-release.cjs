/**
 * Profer Windows 发布（本地构建 + 双通道上传）
 *
 * 用法: node scripts/push-release.cjs <版本号> [--unsigned] [--artifacts-only] [--github-only]
 *
 * 发布顺序不固定：macOS 可以先创建 tag/Release，本脚本随后只补充 Windows 资产；
 * 也可以先跑本脚本、再由 Apple Silicon 补 macOS 资产。release.yml 仅保留手动
 * 构建验证，避免 tag 触发的 CI 与本地发布同时写入同一个 Release。
 *
 * --github-only: 只推送源码/tag 并创建 GitHub Release，跳过国内更新源上传；
 *   releases.json 仅本地生成，待更新源可达后自行补传。
 * --allow-published-release: 允许对已发布的同名 Release 覆盖本平台资产（同版本重发）。
 */
const { execFileSync, execSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { hasMacReleaseAssets, hasWindowsReleaseAssets } = require('./release-asset-contract.cjs');
const { assertPreviousBlockmapPublished, findPurgedBlockmaps } = require('./update-feed-contract.cjs');

const VERSION = process.argv[2];
const UNSIGNED_RELEASE = process.argv.includes('--unsigned');
const ARTIFACTS_ONLY = process.argv.includes('--artifacts-only');
const GITHUB_ONLY = process.argv.includes('--github-only');
// 同版本重发：已发布的 Release 需要显式放行才能覆盖本平台资产（如仅修打包缺陷的重发）。
const ALLOW_PUBLISHED_RELEASE = process.argv.includes('--allow-published-release');
if (!VERSION) {
  console.error('用法: node scripts/push-release.cjs <版本号> [--unsigned] [--artifacts-only] [--github-only] [--allow-published-release]');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'apps/electron');
const OUT = path.join(ELECTRON, 'out');
const TAG = `v${VERSION}`;
const GH_REPO = 'Yuan-lai-ru-ci/ProferAI';
const UPDATE_FEED_URL = 'https://updates.profer.cn/';
const LEGACY_UPDATE_FEED_URL = 'https://profer.cn/profer-updates/';
const WINDOWS_UPDATE_METADATA = 'latest.yml';

/**
 * 生产主机、SSH 用户与端口一律由环境变量提供，仓库内不保存任何默认值。
 * 首次发布前请先在 shell 里导出（或用本地 .env 注入，绝不入库）：
 *   PROFER_UPDATE_SSH_HOST / _USER / _PORT / PROFER_UPDATE_DIR                 新机
 *   PROFER_UPDATE_LEGACY_SSH_HOST / _USER / _PORT / PROFER_UPDATE_LEGACY_DIR   旧机（退役后设 PROFER_UPDATE_SKIP_LEGACY=1）
 */
function requireEnv(name, hint) {
  const value = (process.env[name] || '').trim();
  if (!value) throw new Error(`缺少环境变量 ${name}：${hint}`);
  return value;
}

function assertSafeTarget(target) {
  if (!/^[A-Za-z0-9.-]+$/.test(target.host)) throw new Error(`更新源主机非法: ${target.host}`);
  if (!/^[A-Za-z0-9._-]+$/.test(target.user)) throw new Error(`更新源用户非法: ${target.user}`);
  if (!/^\d{2,5}$/.test(String(target.port))) throw new Error(`更新源端口非法: ${target.port}`);
  if (!/^[A-Za-z0-9._/-]+$/.test(target.dir)) throw new Error(`更新源目录非法: ${target.dir}`);
  return target;
}

let updateTargetsCache = null;
function getUpdateTargets() {
  if (updateTargetsCache) return updateTargetsCache;
  const targets = [assertSafeTarget({
    label: '新机',
    host: requireEnv('PROFER_UPDATE_SSH_HOST', '国内更新源主机'),
    user: requireEnv('PROFER_UPDATE_SSH_USER', '国内更新源 SSH 用户'),
    port: process.env.PROFER_UPDATE_SSH_PORT || '22',
    dir: process.env.PROFER_UPDATE_DIR || '/var/www/updates.profer.cn',
  })];
  // 旧机（profer.cn/profer-updates/ 供数）在退役前保持双写，PROFER_UPDATE_SKIP_LEGACY=1 可关闭。
  if (process.env.PROFER_UPDATE_SKIP_LEGACY !== '1') {
    targets.push(assertSafeTarget({
      label: '旧机',
      host: requireEnv('PROFER_UPDATE_LEGACY_SSH_HOST', '旧更新源主机；已退役可设 PROFER_UPDATE_SKIP_LEGACY=1'),
      user: requireEnv('PROFER_UPDATE_LEGACY_SSH_USER', '旧更新源 SSH 用户'),
      port: process.env.PROFER_UPDATE_LEGACY_SSH_PORT || '22',
      dir: process.env.PROFER_UPDATE_LEGACY_DIR || '/usr/share/nginx/html/profer-updates',
    }));
  }
  updateTargetsCache = targets;
  return targets;
}

const BASH = 'C:/Program Files/Git/usr/bin/bash.exe';
const RELEASE_RETRY_DELAYS_MS = [0, 15_000, 45_000, 90_000];
/**
 * curl 一律用 execFileSync 直呼：本脚本在 Windows 上通过 cmd.exe 执行 `run()`，
 * 单引号会被原样传给 curl（`-w '%{http_code}'` 输出 `'200'` → Number() 得 NaN），
 * 且 `/dev/null` 在 Windows 上不是空设备。绕过 shell 才能两端一致。
 */
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

function run(command, cwd = ROOT) {
  return execSync(command, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function tryRun(command, cwd = ROOT) {
  try {
    return { ok: true, out: run(command, cwd) };
  } catch (error) {
    return { ok: false, out: ((error.stdout || '') + (error.stderr || '') || error.message || '').trim() };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读取更新源当前的 metadata；源不可达或目录为空时返回 null（首次发布到该源）。 */
function readServedMetadata(feedUrl, metadataName) {
  try {
    return execFileSync('curl', ['-fsSL', '--max-time', '20', `${feedUrl}${metadataName}`], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** 取公网 URL 的 HTTP 状态码；拿不到状态码直接抛错，不能把「连不上」当成「存在」。 */
function fetchPublicStatus(url) {
  const output = execFileSync(
    'curl',
    ['-sS', '-I', '-o', NULL_DEVICE, '--max-time', '20', '-w', '%{http_code}', url],
    { encoding: 'utf8' },
  );
  const status = Number(output.trim());
  if (!Number.isFinite(status) || status === 0) throw new Error(`无法访问 ${url}（curl 不可用或网络不通）`);
  return status;
}

/**
 * 差分门禁：确认上一版本的 blockmap 仍在更新源上。
 *
 * Windows 的 NSIS 差分（`NsisUpdater.differentialDownloadInstaller`）同样要旧 blockmap；
 * 缺它不会报错，只会让每次更新静默退化成 220MB+ 全量下载。
 */
function assertDifferentialPrerequisite(feedUrl, metadataName, { warnOnly = false } = {}) {
  const metadataText = readServedMetadata(feedUrl, metadataName);
  if (metadataText === null) {
    console.warn(`[差分门禁] ${feedUrl}${metadataName} 不可读，跳过校验（首次发布到该源？）`);
    return;
  }
  const result = assertPreviousBlockmapPublished({
    feedUrl,
    metadataText,
    version: VERSION,
    fetchStatus: fetchPublicStatus,
    allowMissing: warnOnly || process.env.PROFER_UPDATE_ALLOW_MISSING_PREVIOUS_BLOCKMAP === '1',
  });
  if (result.checked && result.ok) console.log(`  上一版本 blockmap 可用：${result.url}`);
}

/**
 * 告警：最近几个版本的 blockmap 是否已被清理（不阻断发布）。
 *
 * 跨了多个版本的用户发现自己的 blockmap 404 时只能全量下载 224MB。
 */
function warnPurgedBlockmaps(feedUrl) {
  const releasesJson = readServedMetadata(feedUrl, 'releases.json');
  if (releasesJson === null) return;
  const { checked, missing } = findPurgedBlockmaps({
    feedUrl,
    releasesJsonText: releasesJson,
    currentVersion: VERSION,
    installerName: (version) => `Profer-Setup-${version}.exe`,
    fetchStatus: fetchPublicStatus,
  });
  if (missing.length === 0) {
    if (checked.length > 0) console.log(`  最近 ${checked.length} 个版本的 blockmap 都在`);
    return;
  }
  console.warn(`[差分告警] 最近 ${checked.length} 个版本里有 ${missing.length} 个 blockmap 已被清理（这些版本的用户只能全量下载）：`);
  for (const item of missing) console.warn(`  - ${item.version}: ${item.blockmap} → HTTP ${item.status}`);
}

function assertReleaseSigningConfiguration() {
  if (!process.env.CSC_LINK || !process.env.CSC_KEY_PASSWORD) {
    throw new Error('缺少 CSC_LINK 或 CSC_KEY_PASSWORD；签名发布必须提供 Windows 代码签名证书。');
  }
  if (!process.env.PROFER_UPDATE_METADATA_PRIVATE_KEY && !process.env.PROFER_UPDATE_METADATA_PRIVATE_KEY_FILE) {
    throw new Error('缺少更新元数据签名私钥；签名发布必须提供 latest.yml 签名密钥。');
  }
}

function quote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function transientGitHubError(output) {
  return /\b(?:429|500|502|503|504)\b|no server is currently available|timeout|temporar(?:y|ily)|econnreset|eof/i.test(output);
}

async function retryGitHub(label, action, isRecovered = () => false) {
  let lastError = '';
  for (let attempt = 0; attempt < RELEASE_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      const delay = RELEASE_RETRY_DELAYS_MS[attempt];
      console.log(`  ${label}: 等待 ${Math.round(delay / 1000)}s 后重试 (${attempt + 1}/${RELEASE_RETRY_DELAYS_MS.length})`);
      await sleep(delay);
      if (await isRecovered()) return;
    }

    const result = action();
    if (result.ok) return;
    lastError = result.out;
    if (await isRecovered()) return;
    if (!transientGitHubError(result.out) || attempt === RELEASE_RETRY_DELAYS_MS.length - 1) break;
    console.warn(`  ${label}: GitHub 暂时不可用，准备重试。`);
  }
  throw new Error(`${label} 失败: ${lastError.slice(-500)}`);
}

function scp(local, remote, target = getUpdateTargets()[0]) {
  return new Promise((resolve, reject) => {
    const src = local.replace(/\\/g, '/');
    const process = spawn(BASH, ['-c', `scp -o StrictHostKeyChecking=yes -P ${target.port} -q '${src.replace(/'/g, "'\\''")}' ${target.user}@${target.host}:${remote}`]);
    const timer = setTimeout(() => { try { process.kill(); } catch {} }, 600_000);
    process.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`scp ${local} -> ${remote} 失败 (exit ${code})`));
    });
  });
}

function ssh(command, timeout = 30_000, target = getUpdateTargets()[0]) {
  return new Promise((resolve, reject) => {
    const process = spawn(BASH, ['-c', `ssh -o StrictHostKeyChecking=yes -p ${target.port} ${target.user}@${target.host} '${command.replace(/'/g, "'\\''")}'`]);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { process.kill(); } catch {} }, timeout);
    process.stdout.on('data', (data) => { stdout += data; });
    process.stderr.on('data', (data) => { stderr += data; });
    process.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(stdout.trim()) : reject(new Error((stderr || stdout).trim() || `ssh 失败 (exit ${code})`));
    });
  });
}

function remoteTagTarget() {
  const output = run(`git ls-remote --tags origin refs/tags/${TAG} refs/tags/${TAG}^{}`).trim();
  if (!output) return null;
  const lines = output.split(/\r?\n/).map((line) => line.split(/\s+/));
  const peeled = lines.find(([, ref]) => ref.endsWith('^{}'));
  return (peeled || lines[0])[0];
}

function localTagTarget() {
  const result = tryRun(`git rev-list -n 1 refs/tags/${TAG}`);
  return result.ok ? result.out : null;
}

function pushSourceAndTag() {
  // 预检之后再次检查，确保任何 git 写入前都不会覆盖冲突 tag。
  const head = run('git rev-parse HEAD');
  const localTag = localTagTarget();
  const remoteTag = remoteTagTarget();
  if (localTag && localTag !== head) throw new Error(`本地 ${TAG} 不指向 HEAD，拒绝覆盖已有 tag。`);
  if (remoteTag && remoteTag !== head) throw new Error(`远端 ${TAG} 不指向 HEAD，拒绝覆盖已有 tag。`);
  // 另一平台先发布后，tag 所在提交会落后 origin/main（通常只差一个 release-notes/releases.json
  // 同步提交）。补发场景不能推源码，但无需因此中止整个发布；与 push-mac-release.cjs 保持一致。
  const mainIsAncestor = tryRun('git merge-base --is-ancestor origin/main HEAD').ok;
  if (mainIsAncestor) {
    run('git push origin HEAD:main');
  } else if (!localTag) {
    throw new Error('创建新 tag 前 HEAD 必须包含最新 origin/main；请先同步 main。');
  } else {
    console.log('  HEAD 不是 origin/main 的最新提交，跳过源码推送（按补充已发布版本资产处理）。');
  }
  if (!localTag) run(`git tag ${TAG}`);
  if (!remoteTag) run(`git push origin ${TAG}`);
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readReleaseAssets() {
  const result = tryRun(`gh release view ${TAG} --repo ${GH_REPO} --json assets,isDraft,name`);
  if (!result.ok) return null;
  return JSON.parse(result.out);
}

function matchingAsset(asset) {
  const release = readReleaseAssets();
  return Boolean(release?.assets?.some((item) => (
    item.name === asset.name &&
    item.size === asset.size &&
    item.state === 'uploaded' &&
    item.digest === `sha256:${asset.sha256}`
  )));
}

function hasExpectedAssets(release, assets) {
  return Boolean(release?.assets) && assets.every((asset) => release.assets.some((item) => (
    item.name === asset.name &&
    item.size === asset.size &&
    item.state === 'uploaded' &&
    item.digest === `sha256:${asset.sha256}`
  )));
}

async function waitForExpectedAssets(assets) {
  for (let attempt = 0; attempt < RELEASE_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(RELEASE_RETRY_DELAYS_MS[attempt]);
    const release = readReleaseAssets();
    if (hasExpectedAssets(release, assets)) return release;
    console.warn(`  GitHub Release 资产尚未可见，继续等待 (${attempt + 1}/${RELEASE_RETRY_DELAYS_MS.length})`);
  }
  throw new Error('GitHub Release 资产未在重试窗口内全部进入 uploaded 状态。');
}

async function ensureGitHubRelease(assets) {
  const existing = readReleaseAssets();
  if (!existing) {
    const notesFile = path.join(ROOT, 'release-notes', `${TAG}.md`);
    const notesArg = fs.existsSync(notesFile) ? `--notes-file ${quote(notesFile)}` : '--generate-notes';
    await retryGitHub('创建 GitHub Release', () => {
      const result = tryRun(
        `gh release create ${TAG} --repo ${GH_REPO} --title ${quote(`Profer ${TAG}`)} --draft ${notesArg}`,
      );
      return !result.ok && /already exists|already_exists|HTTP 422/i.test(result.out)
        ? { ok: true, out: result.out }
        : result;
    }, () => Boolean(readReleaseAssets()));
  }

  for (const asset of assets) {
    if (matchingAsset(asset)) {
      console.log(`  ${asset.name}: 已存在且 SHA-256 匹配`);
      continue;
    }
    await retryGitHub(`上传 ${asset.name}`, () => tryRun(
      `gh release upload ${TAG} ${quote(asset.path)} --repo ${GH_REPO} --clobber`,
    ), () => matchingAsset(asset));
  }

  const release = await waitForExpectedAssets(assets);
  const releaseName = `Profer ${TAG}`;
  if (release.isDraft) {
    await retryGitHub('发布 GitHub Release', () => tryRun(
      `gh release edit ${TAG} --repo ${GH_REPO} --draft=false --latest --title ${quote(releaseName)}`,
    ), () => {
      const current = readReleaseAssets();
      return current?.isDraft === false && current.name === releaseName;
    });
  } else {
    await retryGitHub('校正 GitHub Release 元数据', () => tryRun(
      `gh release edit ${TAG} --repo ${GH_REPO} --latest --title ${quote(releaseName)}`,
    ), () => readReleaseAssets()?.name === releaseName);
  }
}

(async () => {
  console.log(`=== Profer 本地发布 ${TAG} ===`);
  // macOS 允许先发布；检测到已发布但缺 Windows 资产时，本次按“补充资产”处理。
  const existingRelease = readReleaseAssets();
  const supplementingPublishedRelease = Boolean(
    existingRelease && existingRelease.isDraft === false && !hasWindowsReleaseAssets(existingRelease, VERSION),
  );
  if (supplementingPublishedRelease) {
    console.log(`[发布模式] ${TAG} 已由 macOS 发布，本次仅补充 Windows 资产。`);
  }
  // 必须先完成所有只读预检；随后才允许构建、上传或 Git/GitHub 写入。
  run(`node scripts/verify-release-preflight.cjs ${VERSION}${supplementingPublishedRelease || ALLOW_PUBLISHED_RELEASE ? ' --allow-published-release' : ''}`);

  console.log(`[1/5] ${ARTIFACTS_ONLY ? '校验已有本地产物' : '执行发布验证门禁'}（Windows x64${UNSIGNED_RELEASE ? ' 未签名' : ' 签名'}正式包）...`);
  if (!UNSIGNED_RELEASE) assertReleaseSigningConfiguration();
  if (!GITHUB_ONLY) {
    // 先校验差分前提再构建：缺上一版本 blockmap 会让所有存量用户下次更新
    // 静默退化成 224MB 全量下载，这属于发布前置条件。
    console.log('[0/5] 校验分块差分前提（上一版本 blockmap）...');
    assertDifferentialPrerequisite(UPDATE_FEED_URL, WINDOWS_UPDATE_METADATA);
    if (process.env.PROFER_UPDATE_SKIP_LEGACY !== '1') {
      // 旧机只是备用源：差分失效不影响兜底可用性，不拿它阻断正式发布。
      assertDifferentialPrerequisite(LEGACY_UPDATE_FEED_URL, WINDOWS_UPDATE_METADATA, { warnOnly: true });
    }
    warnPurgedBlockmaps(UPDATE_FEED_URL);
  }
  if (ARTIFACTS_ONLY) {
    run(`bun run ${UNSIGNED_RELEASE ? 'verify:release-assets:unsigned' : 'verify:release-assets'}`, ELECTRON);
    run('bun run verify:packaged-pi-runtime', ELECTRON);
  } else {
    run('bun run typecheck');
    run('bun test --isolate --timeout 30000');
    fs.rmSync(path.join(OUT, 'win-unpacked'), { recursive: true, force: true });
    run(`bun run ${UNSIGNED_RELEASE ? 'release:verify:windows:unsigned' : 'release:verify:windows'}`, ELECTRON);
  }
  // 构建模式和已有产物模式都校验 latest.yml 哈希、CLI 和运行时闭包；已有产物模式不重复构建。

  const assetNames = UNSIGNED_RELEASE
    ? ['latest.yml', `Profer-Setup-${VERSION}.exe`, `Profer-Setup-${VERSION}.exe.blockmap`]
    : ['latest.yml', 'latest.yml.sig', `Profer-Setup-${VERSION}.exe`, `Profer-Setup-${VERSION}.exe.blockmap`];
  const assets = assetNames.map((name) => ({ name, path: path.join(OUT, name) }));
  for (const asset of assets) {
    if (!fs.existsSync(asset.path)) throw new Error(`缺少打包资产: ${asset.path}`);
    asset.size = fs.statSync(asset.path).size;
    asset.sha256 = sha256(asset.path);
  }

  if (!UPDATE_FEED_URL.startsWith('https://')) {
    throw new Error('更新源必须为 HTTPS，拒绝发布。');
  }
  console.log(`[2/5] ${GITHUB_ONLY ? '按 --github-only 跳过国内自动更新源上传' : `上传国内自动更新源（${UPDATE_FEED_URL}）`}...`);
  const installer = assets.find((asset) => asset.name === `Profer-Setup-${VERSION}.exe`);
  const metadata = assets.find((asset) => asset.name === 'latest.yml');
  const metadataSignature = assets.find((asset) => asset.name === 'latest.yml.sig');
  const blockmap = assets.find((asset) => asset.name.endsWith('.blockmap'));
  if (!installer || !metadata || !blockmap || (!UNSIGNED_RELEASE && !metadataSignature)) {
    throw new Error('发布资产列表不完整，拒绝上传。');
  }
  const latestJsonPath = path.join(OUT, 'latest.json');
  fs.writeFileSync(latestJsonPath, JSON.stringify({
    version: VERSION,
    installer: installer.name,
    size: installer.size,
    date: new Date().toISOString().split('T')[0],
  }));
  for (const target of (GITHUB_ONLY ? [] : getUpdateTargets())) {
    const sudo = target.user === 'root' ? '' : 'sudo ';
    await scp(metadata.path, '/tmp/latest.yml', target);
    if (metadataSignature) await scp(metadataSignature.path, '/tmp/latest.yml.sig', target);
    await scp(installer.path, `/tmp/${installer.name}`, target);
    await scp(blockmap.path, `/tmp/${blockmap.name}`, target);
    await scp(latestJsonPath, '/tmp/latest.json', target);
    await ssh(
      `${sudo}mkdir -p ${target.dir} && ` +
      (metadataSignature ? `${sudo}cp /tmp/latest.yml.sig ${target.dir}/ && ` : '') +
      `${sudo}cp /tmp/latest.yml ${target.dir}/ && ` +
      `${sudo}cp /tmp/${installer.name} ${target.dir}/ && ${sudo}cp /tmp/${blockmap.name} ${target.dir}/ && ` +
      `${sudo}cp /tmp/latest.json ${target.dir}/ && ` +
      `${sudo}ln -sf ${target.dir}/${installer.name} ${target.dir}/Profer-latest.exe && ` +
      `${sudo}chmod -R 755 ${target.dir}`,
      120_000,
      target,
    );
    console.log(`  已上传到 ${target.user}@${target.host}:${target.dir}`);
  }

  if (!GITHUB_ONLY) {
    // 上传后确认当前 blockmap 真的可访问：下次发版的差分完全依赖它。
    const currentBlockmapUrl = `${UPDATE_FEED_URL}${blockmap.name}`;
    const status = fetchPublicStatus(currentBlockmapUrl);
    if (status !== 200) throw new Error(`更新源缺少本次 blockmap：${currentBlockmapUrl}（HTTP ${status}）`);
    console.log(`  本次 blockmap 已公开：${currentBlockmapUrl}`);
  }

  console.log('[3/5] 推送源码与版本 tag...');
  pushSourceAndTag();

  console.log('[4/5] 上传 GitHub Release（创建或补充 Windows 资产）...');
  await ensureGitHubRelease(assets);

  // 商业版「版本历史」的数据源是服务器上的 releases.json（apps/electron/src/main/ipc.ts
  // 的 fetchServerReleases），它只能从 GitHub Releases 生成。此前没有脚本也没有任何发布
  // 步骤维护它，两台更新服务器上长期是 404。这里在 Release 落地后立刻刷新，保证版本历史
  // 不会落后于刚发布的版本。
  console.log(`[5/5] 刷新商业版版本历史数据源 releases.json${GITHUB_ONLY ? '（--github-only：仅本地生成）' : ''}...`);
  run(`node scripts/build-releases-json.cjs${GITHUB_ONLY ? '' : ' --upload'}`);
  // macOS 包只能在 Apple Silicon 上构建，Windows 发布流程无法代劳。历史上 v0.15.84 / v0.15.85
  // 就是漏了这一步：GitHub Release 与更新源都只有 Windows 资产，macOS 客户端从 0.15.84 起
  // 再也收不到更新。这里按实际资产状态提示，避免重复提示已补齐的版本。
  if (!hasMacReleaseAssets(readReleaseAssets(), VERSION)) {
    console.log(
      `[提示] 还需在一台 Apple Silicon 机器上补发 macOS 资产：` +
      `node scripts/push-mac-release.cjs ${VERSION}（缺 latest-mac.yml 时 macOS 自动更新会直接失败）`,
    );
  }
  console.log(`=== 发布完成 ${TAG} ===`);
})().catch((error) => {
  console.error(`发布失败: ${error.message}`);
  process.exit(1);
});
