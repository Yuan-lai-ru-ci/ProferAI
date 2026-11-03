import { cpSync, renameSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'

type ForkCopyOptions = Parameters<typeof cpSync>[2]
type ForkRemoveOptions = Parameters<typeof rmSync>[1]

const FORK_FS_RETRY_DELAYS_MS = [0, 50, 150, 400, 1000] as const
const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'ENOTEMPTY'])

function sleepSync(ms: number): void {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

export function describeForkFileError(error: unknown): string {
  const code = errorCode(error)
  const message = error instanceof Error ? error.message : String(error)
  return code ? `${code}: ${message}` : message
}

function isRetryable(error: unknown): boolean {
  const code = errorCode(error)
  return code !== undefined && RETRYABLE_CODES.has(code)
}

function withForkFsRetry<T>(operation: () => T): T {
  let lastError: unknown
  for (const delay of FORK_FS_RETRY_DELAYS_MS) {
    sleepSync(delay)
    try {
      return operation()
    } catch (error) {
      lastError = error
      if (!isRetryable(error)) break
    }
  }
  throw lastError
}

/** Windows 文件锁/Defender 扫描期间的容错复制。失败仍抛出，由调用方决定降级还是回滚。 */
export function copyForkPath(source: string, destination: string, options?: ForkCopyOptions): void {
  withForkFsRetry(() => cpSync(source, destination, options))
}

/** Windows 文件锁/Defender 扫描期间的容错单文件复制。 */
export function copyForkFile(source: string, destination: string): void {
  copyForkPath(source, destination)
}

/** Windows 上临时文件替换目标文件时的容错 rename。 */
export function renameForkFile(source: string, destination: string): void {
  withForkFsRetry(() => renameSync(source, destination))
}

/** Windows 上回滚/清理 fork 半成品时的容错删除。 */
export function removeForkPath(path: string, options: ForkRemoveOptions = { recursive: true, force: true }): void {
  withForkFsRetry(() => rmSync(path, options))
}

/**
 * 异步版容错删除：大目录递归删除不能阻塞主线程。
 *
 * 重试间隔用 setTimeout 而不是 Atomics.wait，否则异步只是换了个地方卡事件循环。
 */
export async function removeForkPathAsync(
  path: string,
  options: ForkRemoveOptions = { recursive: true, force: true },
): Promise<void> {
  let lastError: unknown
  for (const delay of FORK_FS_RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay))
    try {
      await rm(path, options)
      return
    } catch (error) {
      lastError = error
      if (!isRetryable(error)) break
    }
  }
  throw lastError
}

/** 与迁移流程保持同一规则，避免 Windows 下 project 目录键无限随 cwd 增长。 */
export function buildForkProjectKey(projectDir: string): string {
  const sanitized = projectDir.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= 200) return sanitized
  let hash = 0
  for (let index = 0; index < projectDir.length; index += 1) {
    hash = (hash * 31 + projectDir.charCodeAt(index)) | 0
  }
  return `${sanitized.slice(0, 200)}-${Math.abs(hash).toString(36)}`
}
