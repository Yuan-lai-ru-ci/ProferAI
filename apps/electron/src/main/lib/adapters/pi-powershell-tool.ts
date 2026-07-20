import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Type } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentRuntimeEnv } from '../agent-runtime-env'
import { mergeRuntimeEnv } from '../agent-runtime-env'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

const DEFAULT_TIMEOUT_SECONDS = 120
const MAX_TIMEOUT_SECONDS = 600
const MAX_OUTPUT_CHARS = 100_000

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
 * 执行单条 PowerShell 命令。非零退出码保留给调用方呈现，不把 stderr 丢失为 Node 异常。
 * abort/timeout 仅终止当前 powershell.exe；命令型工具不使用 shell:true，避免额外的 cmd.exe 解释层。
 */
export function executePowerShellCommand(command: string, options: ExecutePowerShellOptions): Promise<PowerShellExecutionResult> {
  const executable = options.executable ?? getWindowsPowerShellPath()
  if (!executable) return Promise.reject(new Error('未找到 Windows PowerShell 系统组件'))

  const spawnProcess = options.spawnProcess ?? spawn
  const invocation = createPowerShellInvocation(executable, command)
  const timeoutSeconds = clampTimeout(options.timeoutSeconds)

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

    let output = ''
    let timedOut = false
    let aborted = false
    let settled = false
    const finish = (result: PowerShellExecutionResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutHandle)
      options.signal?.removeEventListener('abort', onAbort)
      resolvePromise(result)
    }
    const stop = (): void => {
      if (!child.killed) child.kill()
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
      const result = await executePowerShellCommand(input.command, {
        cwd,
        env: runtimeEnv?.env,
        timeoutSeconds: input.timeout,
        signal,
        executable,
      })
      return {
        content: [{ type: 'text', text: formatPowerShellResult(result) }],
        details: result,
      } as AgentToolResult<PowerShellExecutionResult>
    },
  }) as ToolDefinition
}
