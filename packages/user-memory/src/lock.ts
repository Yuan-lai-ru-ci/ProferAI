/**
 * 跨进程文件写锁（零依赖）。
 *
 * 为什么需要：画像文件现在是 GUI 和 CLI 的共同写目标。GUI 走 IPC、CLI 走命令行，
 * 两边都可能在同一秒改同一个 `.md`，没有锁就会出现「后写的整份覆盖前写的修改」。
 * 锁只保护**写入**，读取不加锁（读到的半成品最多是上一次完整写入的结果，
 * 因为写入是单次 writeFileSync）。
 *
 * 实现：`open(lockPath, 'wx')` 原子创建。持锁进程崩溃会留下锁文件，
 * 因此超过 staleMs 未更新的锁视为失效并回收。
 */

import { closeSync, openSync, rmSync, statSync, writeSync } from 'node:fs'

export interface FileLockOptions {
  /** 等待锁的总超时（毫秒）。 */
  timeoutMs?: number
  /** 锁文件超过该时长未更新即视为失效（毫秒）。 */
  staleMs?: number
  /** 重试间隔（毫秒）。 */
  pollMs?: number
}

/** 同步睡眠：CLI 与主进程的写路径都是同步的，引入异步会把调用方全部染成 Promise。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isStale(lockPath: string, staleMs: number): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > staleMs
  } catch {
    // 锁文件刚被释放：不是失效，交给下一轮重试。
    return false
  }
}

/**
 * 在锁内执行 fn，返回 fn 的结果；异常原样抛出。
 *
 * 注意：不可重入。同一进程内嵌套调用同一 lockPath 会自锁到超时。
 */
export function withFileLock<T>(lockPath: string, fn: () => T, opts: FileLockOptions = {}): T {
  const timeoutMs = opts.timeoutMs ?? 3000
  const staleMs = opts.staleMs ?? 10_000
  const pollMs = opts.pollMs ?? 25
  const deadline = Date.now() + timeoutMs

  let fd: number | null = null
  while (fd === null) {
    try {
      fd = openSync(lockPath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error

      if (isStale(lockPath, staleMs)) {
        try { rmSync(lockPath) } catch { /* 另一个进程已回收 */ }
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`获取画像写锁超时（${timeoutMs}ms）: ${lockPath}`)
      }
      sleepSync(pollMs)
    }
  }

  try {
    try { writeSync(fd, `${process.pid} ${Date.now()}\n`) } catch { /* 锁内容仅用于诊断 */ }
    return fn()
  } finally {
    try { closeSync(fd) } catch { /* 已关闭 */ }
    try { rmSync(lockPath) } catch { /* 已被回收 */ }
  }
}
