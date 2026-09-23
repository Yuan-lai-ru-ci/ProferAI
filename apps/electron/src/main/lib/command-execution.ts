export type CommandExecutionErrorKind =
  | 'shell_not_found'
  | 'working_directory_error'
  | 'spawn_error'

export interface StructuredExecRequest {
  command: string
  cwd: string
  shell: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  signal?: AbortSignal
  maxOutputBytes?: number
}

export interface CommandExecutionResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  durationMs: number
  shell: string
  cwd: string
  truncated: boolean
  /** Stable semantic classification for pre-spawn and spawn failures. */
  errorKind?: CommandExecutionErrorKind
  /** Native errno or a stable synthetic code when no errno exists. */
  errorCode?: string
}

export interface CommandExecutionFailureInput {
  shell: string
  cwd: string
  errorKind: CommandExecutionErrorKind
  errorCode: string
  stderr?: string
  durationMs?: number
}

export function commandExecutionErrorCode(error: unknown, fallback = 'UNKNOWN'): string {
  const directCode = (error as { code?: unknown } | undefined)?.code
  if (typeof directCode === 'string' && directCode.length > 0) return directCode
  const causeCode = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code
  if (typeof causeCode === 'string' && causeCode.length > 0) return causeCode
  return fallback
}

export function createCommandExecutionFailure(input: CommandExecutionFailureInput): CommandExecutionResult {
  return {
    stdout: '',
    stderr: input.stderr ?? '',
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted: false,
    durationMs: input.durationMs ?? 0,
    shell: input.shell,
    cwd: input.cwd,
    truncated: false,
    errorKind: input.errorKind,
    errorCode: input.errorCode,
  }
}

export interface CommandExecutionCallbacks {
  onStdout?: (data: Buffer) => void
  onStderr?: (data: Buffer) => void
  onSpawn?: (pid: number) => void
}
