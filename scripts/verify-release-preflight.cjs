#!/usr/bin/env node
/**
 * Profer 发布前置校验（只读）。
 *
 * 在任何 SSH/SCP、git push/tag 或 GitHub Release 写入之前执行，
 * 防止 tag/Release 冲突留下半发布状态。
 *
 * 发布顺序不固定：macOS 与 Windows 都可以先创建 tag/Release，后跑的一方只补充
 * 自己的资产。因此 --allow-published-release 表示「本次允许补充已发布 Release」，
 * 但不会放宽版本号、工作树或 tag 目标的一致性约束。
 * 用法：node scripts/verify-release-preflight.cjs <版本号> [--allow-published-release]
 */
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const version = process.argv[2]
const allowPublishedRelease = process.argv.includes('--allow-published-release')
if (!version) throw new Error('用法: node scripts/verify-release-preflight.cjs <版本号> [--allow-published-release]')

const root = path.resolve(__dirname, '..')
const electron = path.join(root, 'apps/electron')
const tag = `v${version}`
const repo = 'Yuan-lai-ru-ci/ProferAI'

function run(command, cwd = root) {
  return execSync(command, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
}

function tryRun(command, cwd = root) {
  try {
    return { ok: true, out: run(command, cwd) }
  } catch (error) {
    return { ok: false, out: ((error.stdout || '') + (error.stderr || '') || error.message || '').trim() }
  }
}

function remoteTagTarget() {
  const output = run(`git ls-remote --tags origin refs/tags/${tag} refs/tags/${tag}^{}`).trim()
  if (!output) return null
  const lines = output.split(/\r?\n/).map((line) => line.split(/\s+/))
  const peeled = lines.find(([, ref]) => ref.endsWith('^{}'))
  return (peeled || lines[0])[0]
}

function localTagTarget() {
  const result = tryRun(`git rev-list -n 1 refs/tags/${tag}`)
  return result.ok ? result.out : null
}

function assertMetadata() {
  const pkg = JSON.parse(fs.readFileSync(path.join(electron, 'package.json'), 'utf8'))
  const changelog = JSON.parse(fs.readFileSync(path.join(electron, 'resources', 'CHANGELOG.json'), 'utf8'))
  if (pkg.version !== version) throw new Error(`package.json 版本为 ${pkg.version}，不是 ${version}`)
  if (!Array.isArray(changelog.releases) || changelog.releases[0]?.version !== version) {
    throw new Error(`CHANGELOG.json 首条版本必须为 ${version}`)
  }
}

function assertCleanWorktree() {
  if (run('git status --porcelain=v1')) throw new Error('工作树不干净；请先提交或清理改动后再发布。')
  if (!tryRun('git diff --check').ok) throw new Error('存在空白错误，不能发布。')
}

/**
 * tag 已存在时只要求它指向 HEAD 的祖先或等于 HEAD：
 * 受保护的是「这个版本属于哪段源码」，不是「发布脚本恰好停在哪一个提交」。
 * 把后者当成门禁会让改一行发布脚本就锁死整个版本，而它并不能证明产物真由 tag 构建。
 * tag 指向无关历史（既不是 HEAD 也不是祖先）时才说明版本与源码对不上，必须拒绝。
 */
function assertTagTargets(head) {
  let localTag = localTagTarget()
  const remoteTag = remoteTagTarget()
  if (!localTag && remoteTag) {
    // 远端已有 tag、本地没有：先拉下来才能做祖先判定，不能就地新建一个指向 HEAD 的 tag。
    tryRun(`git fetch --quiet origin tag ${tag}`)
    localTag = localTagTarget()
  }
  if (localTag && remoteTag && localTag !== remoteTag) {
    throw new Error(`本地 ${tag} 与远端指向不同提交（${localTag} vs ${remoteTag}），拒绝发布。`)
  }
  const declared = localTag || remoteTag
  if (!declared) return
  if (declared === head) return
  if (!tryRun(`git merge-base --is-ancestor ${declared} HEAD`).ok) {
    throw new Error(`${tag} 指向 ${declared}，它不是 HEAD 的祖先；拒绝用一个与版本无关的提交发布。`)
  }
  const ahead = Number(run(`git rev-list --count ${declared}..HEAD`)) || 0
  console.warn(
    `[release-preflight] HEAD 比 ${tag} 多 ${ahead} 个提交（发布工具链或无关改动）：` +
    `不为该版本创建/移动 tag，但产物仍应来自 ${tag} 指向的源码。`,
  )
}

function assertExistingRelease() {
  const result = tryRun(`gh release view ${tag} --repo ${repo} --json isDraft`)
  if (!result.ok) {
    if (/not found|release not found|HTTP 404/i.test(result.out)) return
    throw new Error(`无法确认 GitHub Release ${tag} 状态：${result.out.slice(-300)}`)
  }
  const release = JSON.parse(result.out)
  if (!release.isDraft && !allowPublishedRelease) {
    throw new Error(`GitHub Release ${tag} 已发布；如需补充本平台资产请显式允许补充已发布 Release。`)
  }
}

assertMetadata()
assertCleanWorktree()
run('git fetch origin --prune')
if (!tryRun('git merge-base --is-ancestor origin/main HEAD').ok) {
  // 回填已发布版本的补充资产（典型场景：另一平台已发布后，在 tag 工作树上补本平台
  // 资产）时，HEAD 会停在 tag 上、落后于 origin/main。允许这种分叉，但不能因此
  // 放宽“tag 必须指向 HEAD / 工作树必须干净”的约束——否则就可能把非 tag 内容
  // 冒充成该版本发出去。
  if (!allowPublishedRelease) {
    throw new Error('本地 main 未包含最新 origin/main；请先人工处理分叉，发布脚本不会 rebase 活跃分支。')
  }
  console.warn('[release-preflight] HEAD 落后于 origin/main，按「补充已发布版本资产」处理（仅允许补充资产，不改动版本与 tag）。')
}
const head = run('git rev-parse HEAD')
assertTagTargets(head)
assertExistingRelease()
const tagTarget = localTagTarget()
const tagNote = tagTarget && tagTarget !== head ? `（${tag} 停在 ${tagTarget.slice(0, 8)}，HEAD ${head.slice(0, 8)}）` : ''
console.log(`[release-preflight] ${tag} -> ${head} OK${tagNote}${allowPublishedRelease ? '（允许补充已发布 Release 资产）' : ''}`)
