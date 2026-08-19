#!/usr/bin/env node
/**
 * Profer 发布前置校验（只读）。
 *
 * 在任何 SSH/SCP、git push/tag 或 GitHub Release 写入之前执行，
 * 防止 tag/Release 冲突留下半发布状态。
 * 用法：node scripts/verify-release-preflight.cjs <版本号>
 */
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const version = process.argv[2]
if (!version) throw new Error('用法: node scripts/verify-release-preflight.cjs <版本号>')

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

function assertTagTargets(head) {
  const localTag = localTagTarget()
  const remoteTag = remoteTagTarget()
  if (localTag && localTag !== head) throw new Error(`本地 ${tag} 不指向 HEAD，拒绝覆盖已有 tag。`)
  if (remoteTag && remoteTag !== head) throw new Error(`远端 ${tag} 不指向 HEAD，拒绝覆盖已有 tag。`)
}

function assertExistingRelease() {
  const result = tryRun(`gh release view ${tag} --repo ${repo} --json isDraft`)
  if (!result.ok) {
    if (/not found|release not found|HTTP 404/i.test(result.out)) return
    throw new Error(`无法确认 GitHub Release ${tag} 状态：${result.out.slice(-300)}`)
  }
  const release = JSON.parse(result.out)
  if (!release.isDraft) {
    throw new Error(`GitHub Release ${tag} 已发布；拒绝覆盖已发布版本。`)
  }
}

assertMetadata()
assertCleanWorktree()
run('git fetch origin --prune')
if (!tryRun('git merge-base --is-ancestor origin/main HEAD').ok) {
  throw new Error('本地 main 未包含最新 origin/main；请先人工处理分叉，发布脚本不会 rebase 活跃分支。')
}
const head = run('git rev-parse HEAD')
assertTagTargets(head)
assertExistingRelease()
console.log(`[release-preflight] ${tag} -> ${head} OK`)
