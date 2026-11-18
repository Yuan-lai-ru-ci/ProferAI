import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { AgentRuntimeEnv } from './runtime-env'
import { mergeRuntimeEnv } from './runtime-env'
import { commandExecutionErrorCode, createCommandExecutionFailure, type CommandExecutionCallbacks, type CommandExecutionErrorKind, type CommandExecutionResult, type StructuredExecRequest } from './command-execution'

const FORCE_KILL_WSL_GRACE_MS = 800

const WSL_EXPORT_ENV_KEYS = [
  'PROFER_CLI',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'PROFER_WINDOWS_SHELL',
  'PROFER_WSL_DISTRO',
] as const

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, String.raw`'\''`)}'`
}

export function windowsPathToWslPath(value: string): string {
  const driveMatch = value.match(/^([A-Za-z]):[\\/](.*)$/)
  if (!driveMatch) return value
  const drive = driveMatch[1]!.toLowerCase()
  const rest = driveMatch[2]!.replace(/\\/g, '/')
  return `/mnt/${drive}/${rest}`
}

function buildWslCommand(command: string, env: NodeJS.ProcessEnv | undefined): string {
  const exportLines: string[] = []
  for (const key of WSL_EXPORT_ENV_KEYS) {
    const rawValue = env?.[key]
    if (!rawValue) continue
    const value = key === 'PROFER_CLI' ? windowsPathToWslPath(rawValue) : rawValue
    exportLines.push(`export ${key}=${shellQuote(value)}`)
  }

  return exportLines.length > 0
    ? `${exportLines.join('\n')}\n${command}`
    : command
}

export function buildWslBashArgs(
  runtimeEnv: Pick<AgentRuntimeEnv, 'wslDistro'>,
  cwd: string,
  command: string,
  env: NodeJS.ProcessEnv | undefined,
): string[] {
  return [
    ...(runtimeEnv.wslDistro ? ['--distribution', runtimeEnv.wslDistro] : []),
    '--cd',
    windowsPathToWslPath(cwd),
    '--exec',
    'bash',
    '-lc',
    buildWslCommand(command, env),
  ]
}

export interface ExecuteWslBashOptions {
  runtimeEnv: Pick<AgentRuntimeEnv, 'wslCommand' | 'wslDistro'>
  command: string
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  signal?: AbortSignal
  shell?: string
  spawnProcess?: typeof spawn
  forceKillGraceMs?: number
  terminationGraceMs?: number
  maxOutputBytes?: number
}

/**
 * Executes one WSL Bash command while preserving the host-side process
 * lifecycle. The WSL launcher is still the controlled process; its Linux
 * descendants are terminated through the existing taskkill/SIGKILL fallback.
 */
export function executeWslBashCommand(
  request: ExecuteWslBashOptions,
  callbacks: CommandExecutionCallbacks = {},
): Promise<CommandExecutionResult> {
  const startedAt = Date.now()
  const shell = request.shell ?? 'bash'
  const maxOutputBytes = boundedOutputBytes(request.maxOutputBytes)
  const createResult = (options: {
    stdout: string
    stderr: string
    exitCode: number | null
    signal: NodeJS.Signals | null
    timedOut: boolean
    aborted: boolean
    truncated: boolean
    errorKind?: CommandExecutionErrorKind
    errorCode?: string
  }): CommandExecutionResult => ({
    ...options,
    durationMs: Date.now() - startedAt,
    shell,
    cwd: request.cwd,
  })

  if (request.signal?.aborted) {
    return Promise.resolve(createResult({
      stdout: '',
      stderr: '',
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: true,
      truncated: false,
    }))
  }

  const mergedEnv = mergeRuntimeEnv(process.env, request.env)
  const spawnProcess = request.spawnProcess ?? spawn
  let child: ChildProcess
  try {
    child = spawnProcess(
      request.runtimeEnv.wslCommand ?? 'wsl.exe',
      buildWslBashArgs(request.runtimeEnv, request.cwd, request.command, mergedEnv),
      {
        env: mergedEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
  } catch (error) {
    return Promise.resolve(createCommandExecutionFailure({
      shell,
      cwd: request.cwd,
      errorKind: commandExecutionErrorCode(error) === 'ENOENT' ? 'shell_not_found' : 'spawn_error',
      errorCode: commandExecutionErrorCode(error),
      stderr: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    }))
  }

  if (child.pid) callbacks.onSpawn?.(child.pid)
  const stdout = new BoundedOutputCapture(maxOutputBytes)
  const stderr = new BoundedOutputCapture(maxOutputBytes)

  return new Promise((resolvePromise, reject) => {
    let settled = false
    let timedOut = false
    let aborted = false
    let stopping = false
    let timeoutHandle: NodeJS.Timeout | undefined
    let forceKillTimer: NodeJS.Timeout | undefined
    let terminationGraceHandle: NodeJS.Timeout | undefined

    const result = (
      exitCode: number | null,
      failure?: { errorKind: CommandExecutionErrorKind; errorCode: string },
    ): CommandExecutionResult => createResult({
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      exitCode,
      signal: child.signalCode ?? null,
      timedOut,
      aborted,
      truncated: stdout.truncated || stderr.truncated,
      ...(failure ?? {}),
    })
    const clearForceKill = (): void => {
      if (!forceKillTimer) return
      clearTimeout(forceKillTimer)
      forceKillTimer = undefined
    }
    const cleanup = (): void => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (terminationGraceHandle) clearTimeout(terminationGraceHandle)
      clearForceKill()
      request.signal?.removeEventListener('abort', onAbort)
      child.stdout?.removeListener('data', onStdout)
      child.stderr?.removeListener('data', onStderr)
      child.removeListener('error', onChildError)
      child.removeListener('close', onClose)
    }
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    const forceKillChild = (): void => {
      forceKillTimer = undefined
      if (child.pid === undefined) return
      try {
        process.kill(child.pid, 0)
      } catch {
        return
      }
      try {
        if (process.platform === 'win32') {
          execFile('taskkill', ['/F', '/T', '/PID', String(child.pid)], () => {})
        } else {
          process.kill(child.pid, 'SIGKILL')
        }
        console.warn(`[Pi 适配器] force-killed residual WSL bash pid=${child.pid}`)
      } catch (error) {
        console.warn(`[Pi 适配器] force-kill pid=${child.pid} 失败:`, error)
      }
    }
    const stop = (): void => {
      if (settled || stopping) return
      stopping = true
      if (!child.killed) child.kill('SIGTERM')
      clearForceKill()
      forceKillTimer = setTimeout(forceKillChild, request.forceKillGraceMs ?? FORCE_KILL_WSL_GRACE_MS)
      forceKillTimer.unref?.()
      terminationGraceHandle = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(() => resolvePromise(result(child.exitCode ?? null)))
      }, request.terminationGraceMs ?? LOCAL_BASH_TERMINATION_GRACE_MS)
      // 此定时器负责让当前执行 Promise 收敛，不能 unref 后无限等待。
    }
    const onStdout = (data: Buffer): void => {
      stdout.append(data)
      callbacks.onStdout?.(data)
    }
    const onStderr = (data: Buffer): void => {
      stderr.append(data)
      callbacks.onStderr?.(data)
    }
    const onAbort = (): void => {
      if (timedOut || aborted) return
      aborted = true
      stop()
    }

    const onChildError = (error: Error): void => {
      const failure = { errorKind: 'spawn_error' as const, errorCode: commandExecutionErrorCode(error) }
      if (timedOut || aborted) {
        finish(() => resolvePromise(result(child.exitCode ?? null, failure)))
      } else {
        finish(() => resolvePromise(createCommandExecutionFailure({
          shell,
          cwd: request.cwd,
          ...failure,
          stderr: error.message,
          durationMs: Date.now() - startedAt,
        })))
      }
    }
    const onClose = (exitCode: number | null): void => {
      finish(() => resolvePromise(result(exitCode)))
    }

    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    child.once('error', onChildError)
    child.once('close', onClose)

    if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (settled || timedOut || aborted) return
        timedOut = true
        stop()
      }, request.timeoutMs)
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })
    if (request.signal?.aborted) onAbort()
  })
}


export function classifyLocalBashFailure(
  error: unknown,
  shell: string,
  cwd: string,
): { errorKind: 'shell_not_found' | 'working_directory_error' | 'spawn_error'; errorCode: string } {
  const errorCode = commandExecutionErrorCode(error, 'spawn_error')
  if (errorCode === 'shell_not_found') return { errorKind: 'shell_not_found', errorCode }

  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('工作目录')) {
    return { errorKind: 'working_directory_error', errorCode: errorCode === 'spawn_error' ? 'working_directory_error' : errorCode }
  }

  if (errorCode === 'ENOENT') {
    const shellLooksLikePath = isAbsolute(shell) || shell.includes('/') || shell.includes('\\\\')
    if (shellLooksLikePath && !existsSync(shell)) return { errorKind: 'shell_not_found', errorCode }
    if (!existsSync(cwd)) return { errorKind: 'working_directory_error', errorCode }
  }

  return { errorKind: 'spawn_error', errorCode }
}


const LOCAL_BASH_STDIO_DRAIN_GRACE_MS = 100
const LOCAL_BASH_STDIO_MAX_DRAIN_MS = 5_000
const LOCAL_BASH_TERMINATION_GRACE_MS = 2_000

/**
 * 等待本地 shell 退出，同时防止 detached descendant 继承 stdout/stderr pipe 后
 * 让 Node 的 close 事件永远不触发。若退出后仍有输出，则按输出重新计算 idle
 * grace；absolute deadline 不会重置，防止持续输出无限延长工具调用。
 */
export function waitForLocalBashProcess(
  child: ChildProcess,
  drainGraceMs = LOCAL_BASH_STDIO_DRAIN_GRACE_MS,
  maxDrainMs = LOCAL_BASH_STDIO_MAX_DRAIN_MS,
): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    let settled = false
    let exited = false
    let exitCode: number | null = null
    let stdoutEnded = false
    let stderrEnded = false
    let postExitIdleTimer: NodeJS.Timeout | undefined
    let postExitDeadlineTimer: NodeJS.Timeout | undefined

    const cleanup = (): void => {
      if (postExitIdleTimer) clearTimeout(postExitIdleTimer)
      if (postExitDeadlineTimer) clearTimeout(postExitDeadlineTimer)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      child.removeListener('close', onClose)
      child.stdout?.removeListener('end', onStdoutEnd)
      child.stderr?.removeListener('end', onStderrEnd)
      child.stdout?.removeListener('data', onData)
      child.stderr?.removeListener('data', onData)
    }
    const finalize = (code: number | null): void => {
      if (settled) return
      settled = true
      cleanup()
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolvePromise(code)
    }
    const maybeFinalizeAfterExit = (): void => {
      if (exited && stdoutEnded && stderrEnded) finalize(exitCode)
    }
    const armIdleTimer = (): void => {
      if (postExitIdleTimer) clearTimeout(postExitIdleTimer)
      postExitIdleTimer = setTimeout(() => finalize(exitCode), drainGraceMs)
    }
    const onData = (): void => {
      if (exited && !settled) armIdleTimer()
    }
    const onStdoutEnd = (): void => {
      stdoutEnded = true
      maybeFinalizeAfterExit()
    }
    const onStderrEnd = (): void => {
      stderrEnded = true
      maybeFinalizeAfterExit()
    }
    const onError = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onExit = (code: number | null): void => {
      exited = true
      exitCode = code
      maybeFinalizeAfterExit()
      if (!settled) {
        armIdleTimer()
        postExitDeadlineTimer = setTimeout(() => finalize(exitCode), maxDrainMs)
      }
    }
    const onClose = (code: number | null): void => finalize(code)

    child.stdout?.once('end', onStdoutEnd)
    child.stderr?.once('end', onStderrEnd)
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
    child.once('close', onClose)
  })
}

const LOCAL_BASH_MAX_CAPTURE_BYTES = 1024 * 1024

class BoundedOutputCapture {
  private readonly chunks: Buffer[] = []
  private byteLength = 0
  truncated = false

  constructor(private readonly maxBytes: number) {}

  append(data: Buffer): void {
    if (data.length === 0) return
    if (this.maxBytes === 0) {
      this.truncated = true
      return
    }

    const chunk = Buffer.from(data)
    this.chunks.push(chunk)
    this.byteLength += chunk.length
    while (this.byteLength > this.maxBytes) {
      const first = this.chunks[0]
      if (!first) break
      const overflow = this.byteLength - this.maxBytes
      if (first.length <= overflow) {
        this.chunks.shift()
        this.byteLength -= first.length
      } else {
        this.chunks[0] = first.subarray(overflow)
        this.byteLength -= overflow
      }
      this.truncated = true
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.byteLength).toString('utf8')
  }
}

function boundedOutputBytes(value: number | undefined): number {
  if (value === undefined) return LOCAL_BASH_MAX_CAPTURE_BYTES
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

function killLocalProcessTree(child: ChildProcess): void {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') execFile('taskkill', ['/F', '/T', '/PID', String(child.pid)], () => {})
    else process.kill(-child.pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch { /* already exited */ }
  }
}

export function executeLocalBashCommand(
  request: StructuredExecRequest,
  callbacks: CommandExecutionCallbacks = {},
): Promise<CommandExecutionResult> {
  const startedAt = Date.now()
  const createResult = (options: {
    stdout: string
    stderr: string
    exitCode: number | null
    signal: NodeJS.Signals | null
    timedOut: boolean
    aborted: boolean
    truncated: boolean
    errorKind?: CommandExecutionErrorKind
    errorCode?: string
  }): CommandExecutionResult => ({
    ...options,
    durationMs: Date.now() - startedAt,
    shell: request.shell,
    cwd: request.cwd,
  })

  if (request.signal?.aborted) {
    return Promise.resolve(createResult({
      stdout: '',
      stderr: '',
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: true,
      truncated: false,
    }))
  }

  const maxOutputBytes = boundedOutputBytes(request.maxOutputBytes)
  const stdout = new BoundedOutputCapture(maxOutputBytes)
  const stderr = new BoundedOutputCapture(maxOutputBytes)
  let child: ChildProcess
  try {
    child = spawn(request.shell, ['-c', request.command], {
      cwd: request.cwd,
      env: request.env ?? process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (error) {
    return Promise.resolve(createCommandExecutionFailure({
      shell: request.shell,
      cwd: request.cwd,
      ...classifyLocalBashFailure(error, request.shell, request.cwd),
      stderr: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    }))
  }
  if (child.pid) callbacks.onSpawn?.(child.pid)

  return new Promise((resolvePromise, reject) => {
    let settled = false
    let timedOut = false
    let aborted = false
    let timeoutHandle: NodeJS.Timeout | undefined
    let terminationGraceHandle: NodeJS.Timeout | undefined

    const onStdout = (data: Buffer): void => {
      stdout.append(data)
      callbacks.onStdout?.(data)
    }
    const onStderr = (data: Buffer): void => {
      stderr.append(data)
      callbacks.onStderr?.(data)
    }
    const result = (
      exitCode: number | null,
      failure?: { errorKind: CommandExecutionErrorKind; errorCode: string },
    ): CommandExecutionResult => createResult({
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      exitCode,
      signal: child.signalCode,
      timedOut,
      aborted,
      truncated: stdout.truncated || stderr.truncated,
      ...(failure ?? {}),
    })
    const cleanup = (): void => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (terminationGraceHandle) clearTimeout(terminationGraceHandle)
      request.signal?.removeEventListener('abort', onAbort)
      child.stdout?.removeListener('data', onStdout)
      child.stderr?.removeListener('data', onStderr)
    }
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    const stop = (): void => {
      if (settled) return
      killLocalProcessTree(child)
      terminationGraceHandle ??= setTimeout(() => finish(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        resolvePromise(result(child.exitCode))
      }), LOCAL_BASH_TERMINATION_GRACE_MS)
    }
    const onAbort = (): void => {
      if (timedOut || aborted) return
      aborted = true
      stop()
    }

    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    void waitForLocalBashProcess(child)
      .then((exitCode) => finish(() => resolvePromise(result(exitCode))))
      .catch((error) => {
        const failure = classifyLocalBashFailure(error, request.shell, request.cwd)
        finish(() => resolvePromise({
          ...result(null, failure),
          stderr: error instanceof Error ? error.message : String(error),
        }))
      })

    if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (settled || timedOut || aborted) return
        timedOut = true
        stop()
      }, request.timeoutMs)
    }
    if (request.signal) {
      request.signal.addEventListener('abort', onAbort, { once: true })
      // 关闭“检查 signal”和“注册 listener”之间的竞态窗口。
      if (request.signal.aborted) onAbort()
    }
  })
}
