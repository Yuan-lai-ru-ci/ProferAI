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
const candidates = existsSync(bunStore)
  ? readdirSync(bunStore)
    .filter((name) => name.startsWith('electron-builder@'))
    .map((name) => join(bunStore, name, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'))
    .filter(existsSync)
  : []

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
