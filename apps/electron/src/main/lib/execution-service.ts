import { randomUUID } from 'node:crypto'
import type { AgentRuntimeEnv } from './agent-runtime-env'
import { executeLocalBashCommand, executeWslBashCommand } from './adapters/pi-agent-adapter'
import { executePowerShellCommand } from './adapters/pi-powershell-tool'
import { createCommandExecutionFailure, type CommandExecutionResult, type StructuredExecRequest } from './command-execution'
import type { ProcessHandle, ProcessHandleLauncher, ProcessHandleRuntime } from './process-handle'

export interface ExecutionRequest extends StructuredExecRequest {
  sessionId: string
  handleId?: string
  runtime?: ProcessHandleRuntime
  launcher?: ProcessHandleLauncher
  runtimeEnv?: AgentRuntimeEnv
}

export interface ExecutionSnapshot {
  handle: ProcessHandle
  result?: CommandExecutionResult
}

export interface ExecutionService {
  execute(request: ExecutionRequest): Promise<CommandExecutionResult>
  cancel(handleId: string): Promise<void>
  get(handleId: string): ExecutionSnapshot | undefined
}

interface ActiveExecution {
  controller: AbortController
  snapshot: ExecutionSnapshot
}

export interface PiExecutionServiceOptions {
  runtimeEnv?: AgentRuntimeEnv
  execute?: (request: ExecutionRequest, signal: AbortSignal, onSpawn: (pid: number) => void) => Promise<CommandExecutionResult>
}

function launcherFor(request: ExecutionRequest): ProcessHandleLauncher {
  if (request.launcher) return request.launcher
  const shell = request.shell.toLowerCase()
  if (shell === 'wsl' || request.runtimeEnv?.shellKind === 'wsl') return 'wsl'
  if (shell.includes('powershell') || shell === 'pwsh') return 'powershell'
  return 'bash'
}

function isPowerShellRequest(request: ExecutionRequest): boolean {
  return launcherFor(request) === 'powershell'
}

function createPiExecutor(options: PiExecutionServiceOptions): NonNullable<PiExecutionServiceOptions['execute']> {
  return async (request, signal, onSpawn) => {
    if (isPowerShellRequest(request)) {
      const result = await executePowerShellCommand(request.command, {
        cwd: request.cwd,
        env: request.env,
        timeoutSeconds: request.timeoutMs === undefined ? undefined : request.timeoutMs / 1_000,
        signal,
        executable: request.shell,
        onSpawn,
      })
      return result
    }

    const useWsl = launcherFor(request) === 'wsl' || options.runtimeEnv?.shellKind === 'wsl'
    if (useWsl) {
      if (!options.runtimeEnv) {
        return createCommandExecutionFailure({
          shell: request.shell,
          cwd: request.cwd,
          errorKind: 'shell_not_found',
          errorCode: 'wsl_runtime_missing',
          stderr: 'WSL runtime environment is not configured',
        })
      }
      return executeWslBashCommand({
        runtimeEnv: options.runtimeEnv,
        command: request.command,
        cwd: request.cwd,
        env: request.env,
        timeoutMs: request.timeoutMs,
        signal,
        shell: request.shell,
      }, { onSpawn })
    }

    return executeLocalBashCommand({
      ...request,
      signal,
    }, { onSpawn })
  }
}

/**
 * Pi/Claude 共用的最小执行契约实现。
 * Pi 使用 createPiExecutionService；Claude 可注入自己的 SDK-backed execute，
 * 只复用句柄、取消和结果归档，不接管 Claude SDK 的 process lifecycle。
 */
export function createExecutionService(options: PiExecutionServiceOptions = {}): ExecutionService {
  const executeUnderlying = options.execute ?? createPiExecutor(options)
  const active = new Map<string, ActiveExecution>()
  const completed = new Map<string, ExecutionSnapshot>()

  return {
    async execute(request): Promise<CommandExecutionResult> {
      const handleId = request.handleId ?? randomUUID()
      const controller = new AbortController()
      const runtime = request.runtime ?? 'pi'
      const handle: ProcessHandle = {
        id: handleId,
        sessionId: request.sessionId ?? '',
        runtime,
        launcher: launcherFor(request),
        cwd: request.cwd,
        command: request.command,
        status: 'starting',
        startedAt: Date.now(),
      }
      const snapshot: ExecutionSnapshot = { handle }
      active.set(handleId, { controller, snapshot })

      const onAbort = (): void => controller.abort()
      request.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const result = await executeUnderlying(request, controller.signal, (pid) => {
          handle.shellPid = pid
          handle.status = 'running'
        })
        snapshot.result = result
        handle.status = result.aborted || result.timedOut || result.signal ? 'killed' : result.errorKind ? 'failed' : 'exited'
        handle.exitCode = result.exitCode
        handle.signal = result.signal
        handle.endedAt = Date.now()
        return result
      } catch (error) {
        const result = createCommandExecutionFailure({
          shell: request.shell,
          cwd: request.cwd,
          errorKind: 'spawn_error',
          errorCode: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'EXECUTION_ERROR',
          stderr: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - handle.startedAt,
        })
        snapshot.result = result
        handle.status = 'failed'
        handle.endedAt = Date.now()
        return result
      } finally {
        request.signal?.removeEventListener('abort', onAbort)
        active.delete(handleId)
        completed.set(handleId, snapshot)
      }
    },

    async cancel(handleId): Promise<void> {
      active.get(handleId)?.controller.abort()
    },

    get(handleId): ExecutionSnapshot | undefined {
      return active.get(handleId)?.snapshot ?? completed.get(handleId)
    },
  }
}

export function createPiExecutionService(options: Omit<PiExecutionServiceOptions, 'execute'> = {}): ExecutionService {
  return createExecutionService(options)
}
