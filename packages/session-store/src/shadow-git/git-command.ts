/**
 * Shadow Git 的最小 git 子进程执行层。
 *
 * 这一层只负责「把参数安全地交给 git，并把结果变成数据」：
 * - 全部走 `spawn` 参数数组，不经过 shell，路径里的空格/引号/中文不参与转义博弈
 * - 任何失败（找不到 git、spawn 报错、超时、输出过大）都 resolve 成 `ok:false`，
 *   因为上层 snapshot 语义是「采集失败但主流程继续」，不可能靠 catch 兜住所有调用点
 * - `--git-dir` / `--work-tree` 作为前置参数注入，调用方不需要自己拼接
 */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync } from 'node:fs'

export interface GitCommandResult {
  ok: boolean
  stdout: string
  stderr: string
  /** 进程退出码；被信号杀掉或根本没起来时为 null。 */
  code: number | null
}

export interface GitCommandOptions {
  gitDir?: string
  workTree?: string
  /** 通过 GIT_INDEX_FILE 传入，让同仓库的多个根目录可以并行构建各自的索引。 */
  indexFile?: string
  /** 写入子进程 stdin 的内容（paths 走 stdin 可绕开命令行长度限制）。 */
  input?: string
  /**
   * 把 stdout 直接写到文件。
   *
   * 用于取出 blob 内容：`stdout` 字段是 UTF-8 字符串，二进制文件会被有损转换，
   * 而「恢复用户文件」这条路上一个字节都不能错。写入时不经过内存缓冲，也顺带
   * 绕开了 MAX_OUTPUT_BYTES 对大文件的限制。
   */
  stdoutFile?: string
  timeoutMs?: number
  env?: Record<string, string>
}

export interface GitRunner {
  readonly gitPath: string
  run(args: string[], options?: GitCommandOptions): Promise<GitCommandResult>
}

/** 首次快照可能哈希整个目录，超时给足；增量采集实际在几十毫秒级。 */
const DEFAULT_TIMEOUT_MS = 120_000
/** 与参考实现保持一致的上限：超过这个量说明调用方式有问题，而不是正常输出。 */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024

interface BoundedBuffer {
  chunks: Buffer[]
  bytes: number
  overflowed: boolean
}

function createBoundedBuffer(): BoundedBuffer {
  return { chunks: [], bytes: 0, overflowed: false }
}

function appendChunk(target: BoundedBuffer, chunk: Buffer): void {
  if (target.overflowed) return
  target.bytes += chunk.byteLength
  if (target.bytes > MAX_OUTPUT_BYTES) {
    // 超限后不再保留任何新内容，并让调用方把这次执行判为失败：
    // 半截输出比没有输出更危险（例如半截 ls-tree 会被误当成完整文件列表）。
    target.overflowed = true
    target.chunks = []
    return
  }
  target.chunks.push(chunk)
}

function toText(target: BoundedBuffer): string {
  if (target.overflowed) return ''
  return Buffer.concat(target.chunks).toString('utf8')
}

function describeArgs(args: string[]): string {
  // 只用于诊断日志；截断避免把超长 pathspec 列表整段写进 stderr。
  const joined = args.join(' ')
  return joined.length > 200 ? `${joined.slice(0, 200)}…` : joined
}

function runGit(gitPath: string, args: string[], options: GitCommandOptions): Promise<GitCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fullArgs: string[] = []
  if (options.gitDir) fullArgs.push('--git-dir', options.gitDir)
  if (options.workTree) fullArgs.push('--work-tree', options.workTree)
  fullArgs.push(...args)

  // 工作区可能已被删除（会话目录清理中），此时仍要能执行 update-ref / cat-file 这类仓库级操作。
  const cwd = options.workTree && existsSync(options.workTree) ? options.workTree : process.cwd()
  const env: Record<string, string | undefined> = { ...process.env, ...options.env }
  // 采集绝不接受交互式凭据输入：没有控制台时提示会一直挂到超时。
  env.GIT_TERMINAL_PROMPT = '0'
  if (options.indexFile) env.GIT_INDEX_FILE = options.indexFile

  return new Promise<GitCommandResult>((resolve) => {
    const stdout = createBoundedBuffer()
    const stderr = createBoundedBuffer()
    let settled = false
    let timedOut = false
    let overflowMessage: string | undefined

    const settle = (result: GitCommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const killChild = (): void => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 进程可能已经退出，杀掉失败不影响结论 */
      }
    }

    const fail = (message: string, code: number | null): void => {
      const collected = toText(stderr)
      settle({ ok: false, stdout: toText(stdout), stderr: collected ? `${collected}\n${message}` : message, code })
    }

    let stdoutFd: number | undefined
    if (options.stdoutFile) {
      try {
        stdoutFd = openSync(options.stdoutFile, 'w')
      } catch (error) {
        resolve({ ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error), code: null })
        return
      }
    }
    const releaseStdoutFd = (): void => {
      if (stdoutFd === undefined) return
      try {
        closeSync(stdoutFd)
      } catch {
        /* 已经关闭过：不影响结论 */
      }
      stdoutFd = undefined
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(gitPath, fullArgs, {
        cwd,
        env,
        stdio: ['pipe', stdoutFd ?? 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      // spawn 在极端情况下可能同步抛（非法可执行路径），同样按数据返回。
      releaseStdoutFd()
      resolve({ ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error), code: null })
      return
    }

    const timer = setTimeout(() => {
      timedOut = true
      killChild()
    }, timeoutMs)
    // 定时器不应阻止进程退出。
    if (typeof timer.unref === 'function') timer.unref()

    child.stdout?.on('data', (chunk: Buffer) => {
      appendChunk(stdout, chunk)
      if (stdout.overflowed) {
        overflowMessage = `git 输出超过 ${MAX_OUTPUT_BYTES} 字节，已中止：${describeArgs(fullArgs)}`
        killChild()
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      appendChunk(stderr, chunk)
      if (stderr.overflowed && !overflowMessage) {
        overflowMessage = `git 错误输出超过 ${MAX_OUTPUT_BYTES} 字节，已中止：${describeArgs(fullArgs)}`
        killChild()
      }
    })

    child.on('error', (error: Error) => {
      settle({ ok: false, stdout: toText(stdout), stderr: error.message, code: null })
    })

    child.on('close', (code: number | null) => {
      releaseStdoutFd()
      if (timedOut) {
        fail(`git 命令超时（${timeoutMs}ms）：${describeArgs(fullArgs)}`, code)
        return
      }
      if (overflowMessage) {
        fail(overflowMessage, code)
        return
      }
      settle({ ok: code === 0, stdout: toText(stdout), stderr: toText(stderr), code })
    })

    const stdin = child.stdin
    if (!stdin) return
    stdin.on('error', () => {
      // 子进程提前退出时写 stdin 会 EPIPE；真正的结论由 close 决定，这里只吞掉错误。
    })
    if (options.input !== undefined && options.input.length > 0) stdin.write(options.input)
    stdin.end()
  })
}

export function createGitRunner(input: { gitPath: string }): GitRunner {
  const gitPath = input.gitPath
  return {
    gitPath,
    run(args: string[], options: GitCommandOptions = {}): Promise<GitCommandResult> {
      return runGit(gitPath, args, options)
    },
  }
}
