import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Type } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentRuntimeEnv } from '../agent-runtime-env'
import { mergeRuntimeEnv } from '../agent-runtime-env'
import { registerPendingPiRuntimeProcess, registerPiRuntimeProcessShell } from '../runtime-process-registry'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

/** 普通注册表/进程等只读查询不应长期占住 Agent；耗时脚本可显式传 timeout。 */
export const DEFAULT_TIMEOUT_SECONDS = 30
const MAX_TIMEOUT_SECONDS = 600
const MAX_OUTPUT_CHARS = 100_000
const TERMINATION_GRACE_MS = 5_000

export interface PowerShellInvocation {
  executable: string
  args: string[]
}

export interface PowerShellExecutionResult {
  exitCode: number | null
  output: string
  timedOut: boolean
  aborted: boolean
}

export interface ExecutePowerShellOptions {
  cwd: string
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
  timeoutSeconds?: number
  signal?: AbortSignal
  executable?: string
  spawnProcess?: typeof spawn
  /** 仅用于测试；生产环境按 process.platform 判断是否使用 taskkill 终止整个进程树。 */
  platform?: NodeJS.Platform
  terminationGraceMs?: number
  terminateProcessTree?: (pid: number) => void
  /** Called immediately after PowerShell is spawned, before any command output. */
  onSpawn?: (pid: number) => void
}

/** Windows PowerShell 5.1 是系统组件；使用 SystemRoot 绝对路径避免启动器 PATH 不完整。 */
export function getWindowsPowerShellPath(
  environment: NodeJS.ProcessEnv = process.env,
  pathExists: (path: string) => boolean = existsSync,
): string | null {
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || environment.WINDIR || environment.windir
  if (!systemRoot) return null
  const executable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return pathExists(executable) ? executable : null
}

export function createPowerShellInvocation(executable: string, command: string): PowerShellInvocation {
  return {
    executable,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
  }
}

function clampTimeout(timeoutSeconds: number | undefined): number {
  if (!Number.isFinite(timeoutSeconds)) return DEFAULT_TIMEOUT_SECONDS
  return Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, Math.floor(timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)))
}

function appendOutput(current: string, chunk: Buffer): string {
  if (current.length >= MAX_OUTPUT_CHARS) return current
  return (current + chunk.toString('utf8')).slice(0, MAX_OUTPUT_CHARS)
}

/**
 * Windows 上 child.kill() 只保证通知直接子进程，不能保证它启动的子进程树退出。
 * taskkill /T /F 在后台执行；其失败不影响直接 kill 与 grace-period settle 兜底。
 */
export function terminateWindowsProcessTree(pid: number, spawnProcess: typeof spawn = spawn): void {
  try {
    const killer = spawnProcess('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    })
    killer.unref()
  } catch {
    // 直接 child.kill() 与强制 settle 仍可防止 Agent 永久卡住。
  }
}

/**
 * 执行单条 PowerShell 命令。非零退出码保留给调用方呈现，不把 stderr 丢失为 Node 异常。
 * 超时/中止时同时终止直接子进程及 Windows 进程树；即使 close 事件丢失，也会在 grace period 后结束工具调用。
 */
export function executePowerShellCommand(command: string, options: ExecutePowerShellOptions): Promise<PowerShellExecutionResult> {
  const executable = options.executable ?? getWindowsPowerShellPath()
  if (!executable) return Promise.reject(new Error('未找到 Windows PowerShell 系统组件'))

  const spawnProcess = options.spawnProcess ?? spawn
  const invocation = createPowerShellInvocation(executable, command)
  const timeoutSeconds = clampTimeout(options.timeoutSeconds)
  const terminationGraceMs = Math.max(0, options.terminationGraceMs ?? TERMINATION_GRACE_MS)

  return new Promise((resolvePromise, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnProcess(invocation.executable, invocation.args, {
        cwd: options.cwd,
        env: mergeRuntimeEnv(process.env, options.env),
        windowsHide: true,
        shell: false,
      }) as ChildProcessWithoutNullStreams
    } catch (error) {
      reject(error)
      return
    }

    if (typeof child.pid === 'number') options.onSpawn?.(child.pid)

    let output = ''
    let timedOut = false
    let aborted = false
    let settled = false
    let terminationGraceHandle: ReturnType<typeof setTimeout> | undefined
    let stopping = false
    const finish = (result: PowerShellExecutionResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutHandle)
      if (terminationGraceHandle) clearTimeout(terminationGraceHandle)
      options.signal?.removeEventListener('abort', onAbort)
      resolvePromise(result)
    }
    const stop = (): void => {
      // 防重入：abort 与 timeout 可能相邻触发，确保 child.kill / taskkill 只执行一次，
      // 避免对已退出（可能已被系统复用）的 pid 重复发起强杀。
      if (stopping) return
      stopping = true
      if (!child.killed) child.kill()
      if ((options.platform ?? process.platform) === 'win32' && typeof child.pid === 'number') {
        ;(options.terminateProcessTree ?? ((pid) => terminateWindowsProcessTree(pid, spawnProcess)))(child.pid)
      }
      // 某些 Windows 进程树不会可靠触发父进程 close；不能让 Agent 无限等待。
      terminationGraceHandle ??= setTimeout(() => {
        finish({ exitCode: null, output, timedOut, aborted })
      }, terminationGraceMs)
    }
    const onAbort = (): void => {
      aborted = true
      stop()
    }
    const timeoutHandle = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutSeconds * 1_000)

    if (options.signal?.aborted) {
      onAbort()
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (chunk: Buffer) => { output = appendOutput(output, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { output = appendOutput(output, chunk) })
    child.once('error', (error) => {
      if (settled) return
      clearTimeout(timeoutHandle)
      options.signal?.removeEventListener('abort', onAbort)
      settled = true
      reject(error)
    })
    child.once('close', (exitCode) => {
      finish({ exitCode, output, timedOut, aborted })
    })
  })
}

function formatPowerShellResult(result: PowerShellExecutionResult): string {
  const suffix = result.timedOut
    ? `\nPowerShell 命令在超时后已终止。`
    : result.aborted
      ? `\nPowerShell 命令已中止。`
      : result.exitCode === 0
        ? ''
        : `\nPowerShell 以退出码 ${result.exitCode ?? 'unknown'} 结束。`
  const output = result.output || '(命令未产生输出)'
  return `${output}${suffix}`
}

/** 仅在 Windows 系统组件存在时定义；Bash/Git Bash/WSL 不受此工具影响。 */
export function createWindowsPowerShellToolDefinition(
  sdk: PiSdk,
  cwd: string,
  runtimeEnv: AgentRuntimeEnv | undefined,
  options: {
    platform?: NodeJS.Platform
    environment?: NodeJS.ProcessEnv
    pathExists?: (path: string) => boolean
  } = {},
  sessionId?: string,
): ToolDefinition | undefined {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return undefined
  const executable = getWindowsPowerShellPath(options.environment ?? process.env, options.pathExists ?? existsSync)
  if (!executable) return undefined

  return sdk.defineTool({
    name: 'PowerShell',
    label: '执行 PowerShell',
    description: '在 Windows 原生 PowerShell 中执行命令。适用于 Windows 系统管理、进程、服务、注册表和 PowerShell 语法；跨平台命令继续使用 Bash。',
    promptSnippet: '在 Windows 上执行原生 PowerShell 命令。',
    parameters: Type.Object({
      command: Type.String({ minLength: 1, description: '要执行的 PowerShell 命令。' }),
      timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_SECONDS, description: `超时秒数，默认 ${DEFAULT_TIMEOUT_SECONDS}，最大 ${MAX_TIMEOUT_SECONDS}。` })),
    }),
    async execute(_toolCallId, params, signal) {
      const input = params as { command: string; timeout?: number }
      if (sessionId) registerPendingPiRuntimeProcess(sessionId, input.command, cwd, 'powershell')
      const result = await executePowerShellCommand(input.command, {
        cwd,
        env: runtimeEnv?.env,
        timeoutSeconds: input.timeout,
        signal,
        executable,
        onSpawn: (pid) => {
          if (sessionId) registerPiRuntimeProcessShell(sessionId, input.command, cwd, pid, 'powershell')
        },
      })
      return {
        content: [{ type: 'text', text: formatPowerShellResult(result) }],
        details: result,
      } as AgentToolResult<PowerShellExecutionResult>
    },
  }) as ToolDefinition
}
