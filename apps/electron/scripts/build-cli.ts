#!/usr/bin/env bun
/**
 * 编译 profer CLI 为自包含二进制，打进桌面构建。
 *
 * 设计：
 * - 用 `bun build --compile` 把 apps/cli 连同其 workspace 依赖
 *   （@profer/session-core / @profer/shared）打成单个自包含可执行档，
 *   用户机器无需安装 bun/node 即可运行。
 * - 输出到 apps/electron/resources/bin/，由 electron-builder 经 extraResources
 *   打进 process.resourcesPath/bin/，运行时由主进程注入 PROFER_CLI 暴露给 skill。
 * - 本机架构编译：CI 每个 runner 即目标平台（mac arm64/x64、win x64、linux），
 *   各自产出宿主架构二进制，与 @anthropic-ai SDK native binary 的分发策略一致，
 *   无需交叉编译。
 *
 * 在 electron app 的 build 链中调用（见 package.json build:cli）。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  cleanCliBuildArtifacts,
  createBuildCliInvocation,
  createTemporaryBunPath,
  formatCliBuildArtifactNames,
  tryRemoveTemporaryBun,
} from './build-cli-runtime'

const color = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
}

// apps/electron/scripts → repo 根
const electronDir = resolve(import.meta.dir, '..')
const repoRoot = resolve(electronDir, '../..')
const cliEntry = join(repoRoot, 'apps/cli/src/index.ts')

const isWindows = process.platform === 'win32'
const binName = isWindows ? 'profer.exe' : 'profer'
const outDir = join(electronDir, 'resources/bin')
const outFile = join(outDir, binName)

function fail(msg: string): never {
  console.error(`${color.red}${color.bold}[build:cli] ${msg}${color.reset}`)
  process.exit(1)
}

if (!existsSync(cliEntry)) {
  fail(`找不到 CLI 入口: ${cliEntry}`)
}

mkdirSync(outDir, { recursive: true })
const removedArtifacts = cleanCliBuildArtifacts(outDir)
if (removedArtifacts.length > 0) {
  console.log(
    `${color.dim}[build:cli] 已清理异平台 CLI 残留: ${formatCliBuildArtifactNames(removedArtifacts)}${color.reset}`,
  )
}

console.log(`${color.cyan}[build:cli]${color.reset} 编译 profer CLI → ${color.dim}${outFile}${color.reset}`)

// bun build --compile 在 Windows 上会复制自身。若 bun.exe 位于过长路径，
// 该步骤可能 ENOENT；将当前 Bun 复制到临时短路径后显式指定即可规避。
let tempBunPath: string | undefined
if (isWindows) {
  tempBunPath = createTemporaryBunPath(tmpdir(), Date.now(), process.pid)
  try {
    copyFileSync(process.execPath, tempBunPath)
    console.log(`${color.dim}[build:cli] Windows 短路径 workaround: ${tempBunPath}${color.reset}`)
  } catch (error) {
    tempBunPath = undefined
    console.warn(`${color.yellow}[build:cli] 无法复制 Bun 到临时目录，尝试直接编译: ${error}${color.reset}`)
  }
}

const started = Date.now()
try {
  const invocation = createBuildCliInvocation({
    bunExecutablePath: process.execPath,
    outFile,
    cliEntry,
    compileExecutablePath: tempBunPath,
  })
  const result = spawnSync(
    invocation.command,
    invocation.args,
    { cwd: join(repoRoot, 'apps/cli'), stdio: 'inherit' },
  )

  if (result.status !== 0) {
    fail(`bun build --compile 失败（exit ${result.status}）`)
  }
  if (!existsSync(outFile)) {
    fail(`编译完成但未产出二进制: ${outFile}`)
  }
} finally {
  if (tempBunPath && !tryRemoveTemporaryBun(unlinkSync, tempBunPath)) {
    console.warn(`${color.yellow}[build:cli] 无法删除临时 Bun 副本: ${tempBunPath}${color.reset}`)
  }
}

// macOS arm64 内核要求主可执行档必须带有有效签名，否则 AMFI 会直接 SIGKILL：
// 进程无任何输出、退出码为 137，且不一定有系统提示，极难排查。
// `bun build --compile` 产出的是链接期 ad-hoc 签名的二进制，Bun 随后追加内嵌
// payload 会把该签名置为 invalid（codesign --verify 报 code or signature have
// been modified），因此必须重新 ad-hoc 签名。
// 正式发布路径下 electron-builder 会用 Developer ID 重新签名，不受此步骤影响。
if (process.platform === 'darwin') {
  const signResult = spawnSync(
    'codesign',
    ['--force', '--sign', '-', '--timestamp=none', outFile],
    { stdio: 'inherit' },
  )
  if (signResult.status !== 0) {
    fail(`对 ${binName} 重新 ad-hoc 签名失败（exit ${signResult.status}）`)
  }
  const verifyResult = spawnSync('codesign', ['--verify', '--strict', outFile], { stdio: 'pipe' })
  if (verifyResult.status !== 0) {
    fail(`ad-hoc 签名后校验未通过: ${verifyResult.stderr?.toString().trim() || '未知错误'}`)
  }
  console.log(`${color.dim}[build:cli] 已重新 ad-hoc 签名并通过 codesign --verify --strict${color.reset}`)
}

const sizeMb = (statSync(outFile).size / 1024 / 1024).toFixed(0)
const elapsed = ((Date.now() - started) / 1000).toFixed(1)
console.log(
  `${color.green}${color.bold}[build:cli] ✓${color.reset} ${binName} (${sizeMb}MB, ${elapsed}s)`,
)
