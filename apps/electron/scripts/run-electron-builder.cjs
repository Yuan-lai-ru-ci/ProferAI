#!/usr/bin/env node
/**
 * 在 sync-runtime-deps 清空 apps/electron/node_modules 后，仍从 Bun 工作区锁定的
 * 虚拟依赖仓库调用 electron-builder，避免 bun x/npx 下载未锁定的最新版本。
 */
const { readdirSync, existsSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')

const appDir = resolve(__dirname, '..')
const repoRoot = resolve(appDir, '../..')
const bunStore = join(repoRoot, 'node_modules', '.bun')
const isolatedCandidates = existsSync(bunStore)
  ? readdirSync(bunStore)
    .filter((name) => name.startsWith('electron-builder@'))
    .map((name) => join(bunStore, name, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'))
    .filter(existsSync)
  : []

// Bun 使用 hoisted linker 或兼容性 backend 安装时，electron-builder 会位于
// 工作区根 node_modules，而不会出现在 node_modules/.bun 虚拟仓库中。
// 本地 macOS（尤其是从 NTFS/外置盘迁移到 APFS 后）常采用这种安装方式，
// 因此保留根目录回退，仍然只接受仓库内已安装的固定版本，不触发网络下载。
const hoistedCandidate = join(repoRoot, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
const candidates = isolatedCandidates.length > 0
  ? isolatedCandidates
  : (existsSync(hoistedCandidate) ? [hoistedCandidate] : [])

if (candidates.length !== 1) {
  throw new Error(`期望在 Bun 虚拟依赖仓库中找到唯一 electron-builder CLI，实际找到 ${candidates.length} 个。请先运行 bun install --frozen-lockfile。`)
}

const result = spawnSync(process.execPath, [candidates[0], ...process.argv.slice(2)], {
  cwd: appDir,
  stdio: 'inherit',
  env: process.env,
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
