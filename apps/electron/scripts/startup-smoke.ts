#!/usr/bin/env bun
/**
 * 打包产物启动冒烟：真正把刚打好的应用拉起来一次。
 *
 * 背景（0.16.27）：四套包全部「构建成功 + 签名正确 + 更新元数据齐全」，但主进程 CJS bundle
 * 顶层 require 了纯 ESM 包，应用在加载阶段抛 ERR_PACKAGE_PATH_NOT_EXPORTED，窗口根本没创建。
 * typecheck / 单测 / 包结构 / 签名 / 元数据都发现不了——因为它们从不启动产物。
 *
 * 做法：用隔离的 userData 与配置目录启动解包产物，等主进程探针写出 `window-created`；
 * 探针由 `PROFER_STARTUP_PROBE_FILE` 启用（src/main/lib/startup-probe.ts）。
 *
 * 用法（apps/electron 目录下）：
 *   bun run verify:startup
 *   bun run verify:startup --app out/mac-arm64/Profer.app
 *   PROFER_ELECTRON_OUTPUT_DIR=out-commercial bun run verify:startup
 *   bun run verify:startup --timeout 60000 --keep-profile   # 失败排查时保留隔离目录
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const DEFAULT_TIMEOUT_MS = 45_000
const POLL_INTERVAL_MS = 250

/** 主进程加载阶段崩溃时 Electron 打到 stderr 的特征串。 */
export const FATAL_STDERR_PATTERNS: readonly string[] = [
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'App threw an error during load',
  'A JavaScript error occurred in the main process',
]

export interface StartupArtifact {
  /** 实际要 spawn 的可执行文件。 */
  binary: string
  /** 给人看的产物描述（app bundle 或 exe 路径）。 */
  label: string
}

export interface StartupEvaluation {
  ok: boolean
  reason: string
}

function findMacAppBundle(outputDir: string): string | null {
  const direct = join(outputDir, 'Profer.app')
  if (existsSync(direct)) return direct
  if (!existsSync(outputDir)) return null
  for (const entry of readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(outputDir, entry.name, 'Profer.app')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 解析要启动的产物。显式 `appPath` 优先（可用于启动任意已打包产物），
 * 否则按平台/发行版在 electron-builder 的输出目录里找。
 */
export function resolveStartupArtifact(input: {
  platform: NodeJS.Platform
  outputDir: string
  appPath?: string
}): StartupArtifact {
  const explicit = input.appPath ? resolve(input.appPath) : undefined
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`--app 指向的产物不存在: ${explicit}`)
    if (statSync(explicit).isDirectory()) {
      // 目录只接受 macOS 的 .app bundle：Contents/MacOS 下固定有可执行文件。
      const contents = join(explicit, 'Contents', 'MacOS')
      if (!existsSync(contents)) throw new Error(`--app 目录不是 macOS .app bundle（缺少 Contents/MacOS）: ${explicit}`)
      const names = readdirSync(contents)
      const binary = names.map(name => join(contents, name)).find(path => !statSync(path).isDirectory())
      if (!binary) throw new Error(`.app bundle 缺少可执行文件: ${contents}`)
      return { binary, label: explicit }
    }
    return { binary: explicit, label: explicit }
  }

  if (input.platform === 'darwin') {
    const bundle = findMacAppBundle(input.outputDir)
    if (!bundle) throw new Error(`未找到 macOS 解包产物（Profer.app）: ${input.outputDir}`)
    const macOsDir = join(bundle, 'Contents', 'MacOS')
    const binary = readdirSync(macOsDir)
      .map(name => join(macOsDir, name))
      .find(path => !statSync(path).isDirectory())
    if (!binary) throw new Error(`Profer.app 缺少可执行文件: ${macOsDir}`)
    return { binary, label: bundle }
  }

  if (input.platform === 'win32') {
    const binary = join(input.outputDir, 'win-unpacked', 'Profer.exe')
    if (!existsSync(binary)) throw new Error(`未找到 Windows 解包产物: ${binary}`)
    return { binary, label: binary }
  }

  const binary = join(input.outputDir, 'linux-unpacked', 'profer')
  if (!existsSync(binary)) throw new Error(`未找到 Linux 解包产物: ${binary}`)
  return { binary, label: binary }
}

/** 探针文件是多行 JSON；只取 stage 序列。坏行忽略（写一半被杀时会留残行）。 */
export function parseProbeStages(content: string): string[] {
  const stages: string[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const record = JSON.parse(trimmed) as { stage?: unknown }
      if (typeof record.stage === 'string') stages.push(record.stage)
    } catch {
      continue
    }
  }
  return stages
}

/**
 * 判定一次启动是否成功。
 *
 * - 窗口创建与 Core 就绪都必须通过；
 * - stderr 特征串优先报出来，方便直接认出 0.16.27 这类加载期崩溃；
 * - 只有 `main-loaded` 说明模块求值过了但没建出窗口，与完全没加载区分开。
 */
export function evaluateStartup(input: {
  stages: readonly string[]
  stderr: string
  exitCode: number | null
  timedOut: boolean
}): StartupEvaluation {
  if (input.stages.includes('core-failed')) return { ok: false, reason: '本机 Core 启动失败' }
  const fatal = FATAL_STDERR_PATTERNS.find(pattern => input.stderr.includes(pattern))
  if (fatal) return { ok: false, reason: `主进程加载阶段崩溃（stderr 命中 "${fatal}"）` }
  if (input.stages.includes('bootstrap-failed')) return { ok: false, reason: 'bootstrap 抛错（探针记录 bootstrap-failed），应用进入了降级模式' }
  if (input.stages.includes('window-created') && input.stages.includes('core-ready')) return { ok: true, reason: '主窗口已创建且本机 Core 已连接' }
  if (input.stages.includes('window-created')) return { ok: false, reason: '主窗口已创建，但本机 Core 未就绪' }

  if (input.stages.includes('main-loaded')) {
    return {
      ok: false,
      reason: input.timedOut
        ? 'bundle 已加载，但超时前没有创建主窗口'
        : `bundle 已加载，进程在创建主窗口前退出（exit ${input.exitCode}）`,
    }
  }

  return {
    ok: false,
    reason: input.exitCode !== null && !input.timedOut
      ? `主进程在加载阶段就退出了（exit ${input.exitCode}），探针没有任何记录`
      : '主进程在加载阶段没有任何探针记录（bundle 求值没走到 index.ts 顶部）',
  }
}

interface SmokeOptions {
  appPath?: string
  timeoutMs: number
  outputDir: string
  keepProfile: boolean
}

export function parseArgs(args: readonly string[], env: NodeJS.ProcessEnv = process.env): SmokeOptions {
  const valueOf = (flag: string): string | undefined => {
    const index = args.indexOf(flag)
    return index === -1 ? undefined : args[index + 1]
  }
  const rawTimeout = valueOf('--timeout')
  const timeoutMs = rawTimeout === undefined ? DEFAULT_TIMEOUT_MS : Number(rawTimeout)
  if (!Number.isFinite(timeoutMs) || timeoutMs < 5_000) {
    throw new Error(`--timeout 必须是 >= 5000 的毫秒数，实际为 ${rawTimeout}`)
  }
  const target = valueOf('--target') ?? 'oss'
  if (target !== 'oss' && target !== 'commercial') throw new Error(`--target 只能是 oss 或 commercial，实际为 ${target}`)
  return {
    appPath: valueOf('--app'),
    timeoutMs,
    outputDir: resolve(
      import.meta.dir,
      '..',
      env.PROFER_ELECTRON_OUTPUT_DIR ?? (target === 'commercial' ? 'out-commercial' : 'out'),
    ),
    keepProfile: args.includes('--keep-profile'),
  }
}

function tail(text: string, lines = 40): string {
  const all = text.split('\n').filter(line => line.length > 0)
  return all.slice(-lines).join('\n')
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* 已经退出 */
    }
  }
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(() => {
      if (child.pid) killTree(child.pid)
      resolvePromise()
    }, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolvePromise()
    })
  })
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const artifact = resolveStartupArtifact({
    platform: process.platform,
    outputDir: options.outputDir,
    appPath: options.appPath,
  })

  const profileRoot = mkdtempSync(join(tmpdir(), 'profer-startup-smoke-'))
  const probeFile = join(profileRoot, 'startup-probe.json')
  const userDataDir = join(profileRoot, 'user-data')
  const configDir = join(profileRoot, 'config')

  console.log(`[启动冒烟] 产物: ${artifact.label}`)
  console.log(`[启动冒烟] 隔离目录: ${profileRoot}`)

  const child = spawn(artifact.binary, [`--user-data-dir=${userDataDir}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // 独立进程组：应用会派生 GPU / renderer 等子进程，超时后要一起收掉。
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      // 探针开关：只有这里设置的路径会写入，正常启动不产生文件。
      PROFER_STARTUP_PROBE_FILE: probeFile,
      // 隔离配置根，冒烟绝不碰用户真实的 ~/.profer/。
      PROFER_CONFIG_DIR: configDir,
    },
  })

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', chunk => { stdout += String(chunk) })
  child.stderr?.on('data', chunk => { stderr += String(chunk) })

  let exitCode: number | null = null
  child.once('exit', (code) => { exitCode = code })

  const startedAt = Date.now()
  let timedOut = false
  let stages: string[] = []
  while (Date.now() - startedAt < options.timeoutMs) {
    if (existsSync(probeFile)) {
      stages = parseProbeStages(readFileSync(probeFile, 'utf8'))
      if ((stages.includes('window-created') && stages.includes('core-ready')) || stages.includes('core-failed') || stages.includes('bootstrap-failed')) break
    }
    if (exitCode !== null) break
    // 加载阶段崩溃时 Electron 会弹模态对话框并一直挂着：命中特征串就端掉，不等超时。
    if (FATAL_STDERR_PATTERNS.some(pattern => stderr.includes(pattern))) break
    await new Promise(resolvePromise => setTimeout(resolvePromise, POLL_INTERVAL_MS))
  }
  if (!(stages.includes('window-created') && stages.includes('core-ready')) && exitCode === null) timedOut = true

  const evaluation = evaluateStartup({ stages, stderr, exitCode, timedOut })
  if (child.pid) {
    killTree(child.pid)
    await waitForExit(child)
  }

  if (evaluation.ok) {
    console.log(`[启动冒烟] 通过：${evaluation.reason}（${Math.round((Date.now() - startedAt) / 100) / 10}s）`)
  } else {
    console.error(`[启动冒烟] 失败：${evaluation.reason}`)
    console.error(`[启动冒烟] 探针记录: ${stages.length ? stages.join(' → ') : '(无)'}`)
    if (stderr.trim()) console.error(`[启动冒烟] stderr 末尾:\n${tail(stderr)}`)
    if (stdout.trim()) console.error(`[启动冒烟] stdout 末尾:\n${tail(stdout)}`)
    console.error('[启动冒烟] 这类失败一定意味着“产物起不来”，不要发版。')
  }

  if (!options.keepProfile) rmSync(profileRoot, { recursive: true, force: true })
  else console.error(`[启动冒烟] 隔离目录已保留: ${profileRoot}`)

  process.exit(evaluation.ok ? 0 : 1)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`[启动冒烟] 执行失败: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
