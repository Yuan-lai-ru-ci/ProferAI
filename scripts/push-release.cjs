/**
 * Profer Windows 发布（本地构建 + 双通道上传）
 *
 * 用法: node scripts/push-release.cjs <版本号>
 *
 * GitHub Release 只由本脚本写入。release.yml 仅保留手动构建验证，避免本地
 * 上传与 tag 触发的 CI 同时创建、删除或上传同一个 Release。
 */
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = process.argv[2];
if (!VERSION) {
  console.error('用法: node scripts/push-release.cjs <版本号>');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'apps/electron');
const OUT = path.join(ELECTRON, 'out');
const TAG = `v${VERSION}`;
const GH_REPO = 'Yuan-lai-ru-ci/ProferAI';
const HOST = '47.109.108.57';
const USER = 'ecs-user';
const UPDATE_DIR = '/usr/share/nginx/html/profer-updates';
const BASH = 'C:/Program Files/Git/usr/bin/bash.exe';
const RELEASE_RETRY_DELAYS_MS = [0, 15_000, 45_000, 90_000];

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

function scp(local, remote) {
  return new Promise((resolve, reject) => {
    const src = local.replace(/\\/g, '/');
    const process = spawn(BASH, ['-c', `scp -o StrictHostKeyChecking=no -q '${src.replace(/'/g, "'\\''")}' ${USER}@${HOST}:${remote}`]);
    const timer = setTimeout(() => { try { process.kill(); } catch {} }, 600_000);
    process.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`scp ${local} -> ${remote} 失败 (exit ${code})`));
    });
  });
}

function ssh(command, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const process = spawn(BASH, ['-c', `ssh -o StrictHostKeyChecking=no ${USER}@${HOST} '${command.replace(/'/g, "'\\''")}'`]);
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
  run('git push origin HEAD:main');
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
  // 必须先完成所有只读预检；随后才允许构建、上传或 Git/GitHub 写入。
  run(`node scripts/verify-release-preflight.cjs ${VERSION}`);

  console.log('[1/4] 执行发布验证门禁...');
  run('bun run typecheck');
  run('bun test --isolate --timeout 30000');
  fs.rmSync(path.join(OUT, 'win-unpacked'), { recursive: true, force: true });
  run('bun run release:verify:windows', ELECTRON);

  const assets = [
    'latest.yml',
    `Profer-Setup-${VERSION}.exe`,
    `Profer-Setup-${VERSION}.exe.blockmap`,
  ].map((name) => ({ name, path: path.join(OUT, name) }));
  for (const asset of assets) {
    if (!fs.existsSync(asset.path)) throw new Error(`缺少打包资产: ${asset.path}`);
    asset.size = fs.statSync(asset.path).size;
    asset.sha256 = sha256(asset.path);
  }

  console.log('[2/4] 上传国内自动更新源...');
  const installer = assets[1];
  const latestJsonPath = path.join(OUT, 'latest.json');
  fs.writeFileSync(latestJsonPath, JSON.stringify({
    version: VERSION,
    installer: installer.name,
    size: installer.size,
    date: new Date().toISOString().split('T')[0],
  }));
  const blockmap = assets[2];
  await scp(assets[0].path, '/tmp/latest.yml');
  await scp(installer.path, `/tmp/${installer.name}`);
  await scp(blockmap.path, `/tmp/${blockmap.name}`);
  await scp(latestJsonPath, '/tmp/latest.json');
  await ssh(
    `sudo mkdir -p ${UPDATE_DIR} && sudo cp /tmp/latest.yml ${UPDATE_DIR}/ && ` +
    `sudo cp /tmp/${installer.name} ${UPDATE_DIR}/ && sudo cp /tmp/${blockmap.name} ${UPDATE_DIR}/ && ` +
    `sudo cp /tmp/latest.json ${UPDATE_DIR}/ && ` +
    `sudo ln -sf ${UPDATE_DIR}/${installer.name} ${UPDATE_DIR}/Profer-latest.exe && ` +
    `sudo chmod -R 755 ${UPDATE_DIR}`,
    120_000,
  );

  console.log('[3/4] 推送源码与版本 tag...');
  pushSourceAndTag();

  console.log('[4/4] 上传 GitHub Release（本地唯一写入者）...');
  await ensureGitHubRelease(assets);
  console.log(`=== 发布完成 ${TAG} ===`);
})().catch((error) => {
  console.error(`发布失败: ${error.message}`);
  process.exit(1);
});
