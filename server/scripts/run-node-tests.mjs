#!/usr/bin/env node
/**
 * 跨平台执行服务端 Node 原生测试。
 *
 * Windows 的 npm/Bun 脚本不保证展开 ** glob，因此不能把 glob 直接交给
 * `node --test`。这里显式收集 *.node.test.mjs，确保 CI 与本地使用相同门禁。
 */
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const sourceRoot = resolve('src')

function collectTests(directory) {
  const tests = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) tests.push(...collectTests(path))
    else if (entry.endsWith('.node.test.mjs')) tests.push(path)
  }
  return tests
}

const tests = collectTests(sourceRoot).sort()
if (tests.length === 0) {
  console.error('未找到服务端 Node 原生测试（*.node.test.mjs）')
  process.exit(1)
}

// `bun run` 在 Windows 会以 Bun 自身承载脚本，process.execPath 因而是 bun.exe。
// 优先使用 PATH 中的 node；若 SDK 隔离 PATH 未含 Node，则回退到标准安装位置。
const standardWindowsNode = join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe')
const configuredNode = process.env.NODE && !/bun(?:\.exe)?$/i.test(process.env.NODE) ? process.env.NODE : undefined
const nodeExecutable = process.platform === 'win32' && existsSync(standardWindowsNode)
  ? standardWindowsNode
  : (configuredNode || 'node')
const result = spawnSync(nodeExecutable, ['--test', '--test-concurrency=1', ...tests], {
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
