import type { RuntimeProcessRecord } from './runtime-process-registry'

export type ProcessHandleRuntime = 'pi' | 'claude'
export type ProcessHandleLauncher = 'bash' | 'powershell' | 'wsl' | 'claude'
export type ProcessHandleStatus = 'starting' | 'running' | 'exited' | 'killed' | 'failed'

/**
 * 统一的进程归属句柄。shellPid 是 Profer 直接启动的 launcher；pid 只有在
 * process-monitor 用命令、cwd、端口和 startTime 确认后才表示实际服务进程。
 */
export interface ProcessHandle {
  id: string
  sessionId: string
  runtime: ProcessHandleRuntime
  launcher: ProcessHandleLauncher
  shellPid?: number
  pid?: number
  startTime?: number
  cwd: string
  command: string
  status: ProcessHandleStatus
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  startedAt: number
  endedAt?: number
}

export interface ProcessHandleExit {
  status?: Extract<ProcessHandleStatus, 'exited' | 'killed' | 'failed'>
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  endedAt?: number
}

/** 将持久化 registry 记录映射成 runtime-neutral handle，不改变旧 registry 格式。 */
export function processHandleFromRuntimeRecord(record: RuntimeProcessRecord): ProcessHandle {
  return {
    id: record.id,
    sessionId: record.sessionId,
    runtime: record.runtime,
    launcher: record.launcher,
    ...(record.shellPid !== undefined && { shellPid: record.shellPid }),
    ...(record.pid !== undefined && { pid: record.pid }),
    ...(record.startTime !== undefined && { startTime: record.startTime }),
    cwd: record.cwd,
    command: record.command,
    status: record.status === 'pending' ? 'starting' : record.status,
    startedAt: record.launchedAt,
    ...(record.status === 'exited' && { endedAt: record.lastObservedAt }),
  }
}

export function completeProcessHandle(handle: ProcessHandle, exit: ProcessHandleExit = {}): ProcessHandle {
  const status = exit.status ?? (exit.signal ? 'killed' : 'exited')
  return {
    ...handle,
    status,
    ...(exit.exitCode !== undefined && { exitCode: exit.exitCode }),
    ...(exit.signal !== undefined && { signal: exit.signal }),
    endedAt: exit.endedAt ?? Date.now(),
  }
}

export function isProcessHandleOwnedBySession(handle: ProcessHandle, sessionId: string): boolean {
  return handle.sessionId === sessionId && handle.runtime === 'pi'
}
