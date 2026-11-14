#!/usr/bin/env bun
/**
 * 可视化打包脚本
 *
 * 功能：
 * - 分步执行打包流程，每步带计时和状态指示
 * - 支持只构建当前架构（--current-arch）加速开发测试
 * - 支持详细输出模式（--verbose）查看 electron-builder 完整日志
 * - 支持跳过代码签名（--no-sign，Mac 验收包专用）
 * - macOS 一律在打包后补做 ad-hoc 签名并钉死 designated requirement；
 *   无签名包会导致 Squirrel.Mac 静默拒绝所有自更新（见 scripts/macos-signature.cjs）
 * - 支持只构建 DMG 或 ZIP（--dmg / --zip）
 *
 * 使用：
 * bun run scripts/dist.ts --win                 # 完整 Windows 打包
 * bun run scripts/dist.ts --current-arch            # 只构建当前架构（快速）
 * bun run scripts/dist.ts --current-arch --verbose   # 当前架构 + 详细日志
 * bun run scripts/dist.ts --current-arch --dmg       # 当前架构 + 只构建 DMG
 * bun run scripts/dist.ts --mac --current-arch --no-sign # Apple Silicon 本地 macOS 包
 *
 * 未显式指定平台时按宿主推导（darwin→mac / win32→win / linux→linux）。
 * 注意：Linux 当前不是受支持的发布目标（缺少 Claude 原生二进制与 Linux 构建验证），
 * 因此 --linux 会被 packaging-host 门禁显式拒绝，而不是产出一个 Claude 必然失败的包。
 */

import { spawnSync } from 'child_process'
import { delimiter, dirname, join } from 'path'

const { assertPackagingHost, assertSupportedPackagingTarget } = require('./packaging-host.cjs') as {
  assertPackagingHost: (targetPlatform: 'mac' | 'win' | 'linux', hostPlatform?: string) => void
  assertSupportedPackagingTarget: (targetPlatform: 'mac' | 'win' | 'linux') => void
}

// ============================================
// 类型定义
// ============================================

interface StepResult {
  name: string
  duration: number
  success: boolean
  skipped: boolean
}

interface DistOptions {
  currentArch: boolean
  verbose: boolean
  noSign: boolean
  targetFormat: 'all' | 'dmg' | 'zip' | 'dir'
  platform: 'mac' | 'win' | 'linux'
  /** 发行版：决定主进程构建目标、打包配置与产物目录。 */
  target: 'oss' | 'commercial'
}

// ============================================
// 工具函数
// ============================================

/** ANSI 颜色代码 */
const color = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  bgGreen: '\x1b[42m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
}

/** 格式化时间 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60000)
  const sec = ((ms % 60000) / 1000).toFixed(0)
  return `${min}m${sec}s`
}

/** 打印分隔线 */
function printSeparator(): void {
  console.log(`${color.dim}${'─'.repeat(60)}${color.reset}`)
}

/** 打印步骤开始 */
function printStepStart(step: number, total: number, name: string): void {
  console.log(
    `\n${color.bgBlue}${color.bold} 步骤 ${step}/${total} ${color.reset} ${color.cyan}${name}${color.reset}`
  )
  printSeparator()
}

/** 打印步骤结果 */
function printStepResult(result: StepResult): void {
  if (result.skipped) {
    console.log(
      `${color.bgYellow}${color.bold} 跳过 ${color.reset} ${result.name} ${color.dim}(已跳过)${color.reset}`
    )
    return
  }
  const icon = result.success
    ? `${color.bgGreen}${color.bold} 完成 ${color.reset}`
    : `${color.bgRed}${color.bold} 失败 ${color.reset}`
  const time = `${color.dim}(${formatDuration(result.duration)})${color.reset}`
  console.log(`${icon} ${result.name} ${time}`)
}

/** 执行命令并计时 */
function runStep(
  name: string,
  command: string,
  args: string[],
  options: { verbose: boolean; env?: Record<string, string>; skip?: boolean }
): StepResult {
  if (options.skip) {
    return { name, duration: 0, success: true, skipped: true }
  }

  const start = Date.now()
  const stdio = options.verbose ? 'inherit' : 'pipe'

  const result = spawnSync(command, args, {
    stdio: [stdio, stdio, 'inherit'], // 始终显示 stderr
    cwd: join(import.meta.dir, '..'),
    // 通过绝对路径调用 Bun 时，宿主 shell 未必将 ~/.bun/bin 放入 PATH。
    // 打包步骤内部大量脚本仍使用 `bun`，因此显式注入当前运行时目录，
    // 兼容 Finder、IDE 和干净终端中直接执行 dist.ts 的场景。
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
      ...options.env,
    },
    shell: true,
  })

  const duration = Date.now() - start

  if (result.status !== 0 && !options.verbose && result.stdout) {
    // 非 verbose 模式失败时，打印 stdout 帮助排查
    console.log(result.stdout.toString())
  }

  return { name, duration, success: result.status === 0, skipped: false }
}

// ============================================
// 主流程
// ============================================

/**
 * 默认目标平台：按宿主推导。
 *
 * `dist:fast` / `dist:debug` 的语义是「当前宿主的快速打包」（见 AGENTS.md），
 * 因此未显式指定平台时必须跟随宿主，而不是固定 win：固定 win 会让 macOS 上的
 * `bun run dist:fast` 被 Windows 宿主门禁直接拒绝。
 *
 * 未知宿主返回 undefined：由调用方报错退出，不静默伪造任何一个平台。
 */
export function defaultPlatformForHost(
  hostPlatform: NodeJS.Platform,
): DistOptions['platform'] | undefined {
  if (hostPlatform === 'darwin') return 'mac'
  if (hostPlatform === 'win32') return 'win'
  if (hostPlatform === 'linux') return 'linux'
  return undefined
}

/**
 * 发行版对应的 electron-builder 产物目录。
 *
 * 两个发行版必须物理隔离：同名 `latest*.yml` 在同一目录会互相覆盖，
 * 构建后的 verify 步骤也必须指向正确的目录，否则只会验证上一次留下的另一版产物。
 */
export function resolveOutputDir(target: DistOptions['target']): 'out' | 'out-commercial' {
  return target === 'commercial' ? 'out-commercial' : 'out'
}

/** 发行版对应的有序构建链；实际打包和回归测试共用，避免 main 与 renderer 选到不同版别。 */
export function resolveBuildSteps(target: DistOptions['target']): { name: string; script: string }[] {
  const commercial = target === 'commercial'
  return [
    { name: `构建主进程 (${target})`, script: commercial ? 'build:main-commercial' : 'build:main' },
    { name: '校验主进程发行版', script: `verify:build-target:${target}` },
    // OSS 侧用 strict：基线已清空，任何商业内容回流都应直接阻断出包。
    { name: '校验发行版边界', script: commercial ? 'verify:commercial-includes-commercial' : 'verify:oss-excludes-commercial:strict' },
    { name: '构建 Preload (esbuild)', script: 'build:preload' },
    { name: '构建渲染进程 (Vite)', script: commercial ? 'build:renderer:commercial' : 'build:renderer' },
    { name: '校验界面发行版', script: `verify:renderer-edition:${target}` },
    { name: '编译 Profer CLI (bun --compile)', script: 'build:cli' },
    { name: '编译手写笔 OCR', script: 'build:pen-ocr' },
    { name: '复制资源文件', script: 'build:resources' },
    { name: '同步主进程运行时依赖', script: 'sync:runtime-deps' },
  ]
}

/** 顺序执行，首个失败即停止；调用方可注入命令执行器，无须在回归测试中启动外部进程。 */
export function runBuildSteps(
  target: DistOptions['target'],
  execute: (step: { name: string; script: string }) => StepResult,
): StepResult[] {
  const results: StepResult[] = []
  for (const step of resolveBuildSteps(target)) {
    const result = execute(step)
    results.push(result)
    if (!result.success) break
  }
  return results
}

/** 参数解析（宿主平台与 argv 可注入，便于跨平台解析测试）。 */
export function parseArgs(
  args: readonly string[] = process.argv.slice(2),
  hostPlatform: NodeJS.Platform = process.platform,
): DistOptions {
  const explicitPlatform = args.includes('--mac')
    ? 'mac' as const
    : args.includes('--win')
      ? 'win' as const
      : args.includes('--linux')
        ? 'linux' as const
        : undefined
  const platform = explicitPlatform ?? defaultPlatformForHost(hostPlatform)
  if (!platform) {
    throw new Error(`不支持在 ${hostPlatform} 宿主上打包；请显式选择 --mac / --win / --linux。`)
  }
  // --target 缺省为 oss，与既有 `dist:mac` / `dist:win` 行为一致；
  // 显式传错值要报错，不能静默回退成开源版产物。
  const targetIndex = args.indexOf('--target')
  const rawTarget = targetIndex === -1 ? 'oss' : args[targetIndex + 1]
  if (rawTarget !== 'oss' && rawTarget !== 'commercial') {
    throw new Error(`--target 只能是 oss 或 commercial，实际为 ${rawTarget ?? '(缺失)'}`)
  }
  return {
    currentArch: args.includes('--current-arch'),
    verbose: args.includes('--verbose'),
    noSign: args.includes('--no-sign'),
    target: rawTarget,
    targetFormat: args.includes('--dmg')
      ? 'dmg'
      : args.includes('--zip')
        ? 'zip'
        : args.includes('--dir')
          ? 'dir'
          : 'all',
    platform,
  }
}

function main(): void {
  let opts: DistOptions
  try {
    opts = parseArgs()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
  const arch = process.arch // arm64 或 x64
  const results: StepResult[] = []

  try {
    // 目标平台支持门禁（当前 Linux 未纳入发布目标，原因见 packaging-host.cjs 注释）。
    assertSupportedPackagingTarget(opts.platform)
    assertPackagingHost(opts.platform, process.platform)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }

  // 只支持在 Apple Silicon 真机上构建 macOS 产物。拒绝从 Windows/Linux
  // 伪造 macOS 产物，也不让 Intel Mac 被误认为已进入支持范围。
  if (opts.platform === 'mac' && process.platform !== 'darwin') {
    console.error('macOS 打包必须在 Apple Silicon Mac 上运行；当前宿主不是 darwin。')
    process.exit(2)
  }
  if (opts.platform === 'mac' && arch !== 'arm64') {
    console.error(`P1 仅支持 Apple Silicon arm64 本地构建，当前架构为 ${arch}。`)
    process.exit(2)
  }

  // 打印配置信息
  console.log(`\n${color.bgBlue}${color.bold} Profer 打包工具 ${color.reset}\n`)
  console.log(`  ${color.bold}发行版${color.reset}:   ${opts.target}${opts.target === 'commercial' ? ' (商业版)' : ' (开源版)'}`)
  console.log(`  ${color.bold}平台${color.reset}:     ${opts.platform}`)
  console.log(`  ${color.bold}架构${color.reset}:     ${opts.currentArch ? arch + ' (仅当前)' : opts.platform === 'mac' ? 'arm64' : 'arm64 + x64'}`)
  console.log(`  ${color.bold}格式${color.reset}:     ${opts.targetFormat}`)
  console.log(`  ${color.bold}签名${color.reset}:     ${opts.noSign ? '强制 ad-hoc + 钉死 DR（验收包）' : '优先真实身份，缺失时 ad-hoc + 钉死 DR'}`)
  console.log(`  ${color.bold}详细日志${color.reset}: ${opts.verbose ? '开启' : '关闭'}`)
  printSeparator()

  const buildSteps = resolveBuildSteps(opts.target)
  const totalSteps = buildSteps.length + 1 + (opts.platform === 'mac' ? 3 : 0)
  const outputDir = resolveOutputDir(opts.target)
  let step = 0

  // 两版共用编排，版别在生成步骤时一次确定；任何构建或身份断言失败都不得进入打包。
  results.push(...runBuildSteps(opts.target, (buildStep) => {
    step++
    printStepStart(step, totalSteps, buildStep.name)
    const result = runStep(buildStep.name, 'bun', ['run', buildStep.script], { verbose: opts.verbose })
    printStepResult(result)
    return result
  }))
  if (results.some((result) => !result.success)) return printSummary(results)

  // ── electron-builder 打包 ──
  step++
  printStepStart(step, totalSteps, 'Electron Builder 打包')

  const builderArgs = ['electron-builder', `--${opts.platform}`]
  // 商业版用独立配置：独立产物目录、独立文件名、独立更新源（app-update.yml）。
  if (opts.target === 'commercial') {
    builderArgs.push('--config', 'electron-builder.commercial.yml')
  }
  // 只产出本地验收包：绝不能因 package.json 中的 GitHub publish 配置上传资产。
  // 发布一律走 push-release.cjs / push-mac-release.cjs，CI 侧也显式 --publish never。
  builderArgs.push('--publish', 'never')

  // 只构建当前架构
  if (opts.currentArch) {
    builderArgs.push(`--${arch}`)
  }

  // macOS 的签名由 electron-builder.yml 的 afterSign 钩子统一负责：
  // 有真实 Developer ID 身份时用它，没有时补 ad-hoc 并把 designated requirement
  // 钉死为 bundle id。因此这里不再要求 forceCodeSigning —— 无 Developer ID 时它必然
  // 失败，而“包必须可验证”的约束改由构建后的 verify:mac-signature 对真实产物断言。

  // 指定输出格式
  if (opts.targetFormat === 'dmg') {
    builderArgs.push('--config.mac.target=dmg')
  } else if (opts.targetFormat === 'zip') {
    builderArgs.push('--config.mac.target=zip')
  } else if (opts.targetFormat === 'dir') {
    builderArgs.push('--dir')
  }

  // 签名环境变量
  const builderEnv: Record<string, string> = {}
  if (opts.noSign) {
    builderEnv['CSC_IDENTITY_AUTO_DISCOVERY'] = 'false'
  }
  if (opts.verbose) {
    builderEnv['DEBUG'] = 'electron-builder,electron-builder:*'
  }

  results.push(
    runStep('Electron Builder', 'node', ['scripts/run-electron-builder.cjs', ...builderArgs.slice(1)], {
      verbose: true, // 打包步骤始终显示输出
      env: builderEnv,
    })
  )
  printStepResult(results[results.length - 1])
  if (!results[results.length - 1].success) return printSummary(results)

  if (opts.platform === 'mac') {
    // 所有 verify 步骤都指向本次发行版的产物目录；商业版在 out-commercial/。
    const verifyEnv = { PROFER_ELECTRON_OUTPUT_DIR: outputDir }

    step++
    printStepStart(step, totalSteps, '验证 macOS 安装包资源闭包')
    results.push(
      runStep('验证 macOS 安装包', 'bun', ['run', 'verify:mac-package'], { verbose: opts.verbose, env: verifyEnv })
    )
    printStepResult(results[results.length - 1])
    if (!results[results.length - 1].success) return printSummary(results)

    step++
    printStepStart(step, totalSteps, '验证 macOS 签名契约（ad-hoc + 钉死 DR）')
    results.push(
      runStep('验证 macOS 签名', 'bun', ['run', 'verify:mac-signature'], { verbose: true, env: verifyEnv })
    )
    printStepResult(results[results.length - 1])
    if (!results[results.length - 1].success) return printSummary(results)

    step++
    printStepStart(step, totalSteps, '验证 macOS 更新元数据')
    results.push(
      runStep('验证 macOS 更新元数据', 'node', ['scripts/verify-macos-update-assets.cjs', '--edition', opts.target], {
        verbose: opts.verbose,
        env: verifyEnv,
      })
    )
    printStepResult(results[results.length - 1])
  }

  printSummary(results)
}

/** 打印汇总报告 */
function printSummary(results: StepResult[]): void {
  console.log(`\n${color.bgBlue}${color.bold} 打包汇总 ${color.reset}\n`)

  const totalTime = results.reduce((sum, r) => sum + r.duration, 0)
  const allSuccess = results.every((r) => r.success)

  // 各步骤耗时表
  for (const r of results) {
    if (r.skipped) {
      console.log(`  ${color.dim}○${color.reset} ${r.name.padEnd(20)} ${color.dim}跳过${color.reset}`)
      continue
    }
    const icon = r.success ? `${color.green}●${color.reset}` : `${color.red}●${color.reset}`
    const bar = r.duration > 0 ? '█'.repeat(Math.min(Math.ceil(r.duration / 1000), 30)) : ''
    const barColor = r.duration > 30000 ? color.red : r.duration > 10000 ? color.yellow : color.green
    console.log(
      `  ${icon} ${r.name.padEnd(20)} ${barColor}${bar}${color.reset} ${formatDuration(r.duration)}`
    )
  }

  printSeparator()
  const statusIcon = allSuccess
    ? `${color.bgGreen}${color.bold} 成功 ${color.reset}`
    : `${color.bgRed}${color.bold} 失败 ${color.reset}`
  console.log(`  ${statusIcon}  总耗时: ${color.bold}${formatDuration(totalTime)}${color.reset}\n`)

  process.exit(allSuccess ? 0 : 1)
}

// 直接执行时才跑主流程；被测试 import 时不产生副作用。
if (import.meta.main) main()
