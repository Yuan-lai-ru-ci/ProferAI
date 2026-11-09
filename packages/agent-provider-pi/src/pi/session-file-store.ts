/**
 * Pi session 文件的宿主侧写入口（Profer 独占写）。
 *
 * ## 为什么要自己写
 *
 * Pi SDK 的 `SessionManager` 默认把 entry **边跑边落盘**（`_persist`）。于是 Pi 文件既是
 * 「SDK 的输入」又是「SDK 的输出」：Profer 的历史与它只能靠事后比对来确认一致，一旦不一致
 * 就只能整份还原并报错——两套真相、事后修补。
 *
 * 现在改成：SDK 只在内存里跑（`SessionManager.inMemory`，`persist=false`，`_persist` 直接
 * 早退，实测不改文件），正式文件由本模块按 turn 边界写入。于是：
 * - 文件内容 = SDK 实际产出的 entry（逐字复制 `JSON.stringify(entry)`），前缀逐字节稳定，
 *   prompt cache 不受影响；
 * - 回退 = 按保留历史重写文件，不再需要「截断 + 校验 + 还原」。
 *
 * ## 与 SDK 落盘时机保持一致
 *
 * SDK 在「整个会话还没有任何 assistant 消息」时不写文件（避免把失败轮次的用户消息留在
 * transcript 里被下次 resume 当成上下文）。本模块的 `flush()` 保留同一条规则：只有会话里
 * 出现 assistant 消息后才开始写。这样「失败的首轮不产生 Pi 文件」这一既有行为不变。
 *
 * ## 写入粒度
 *
 * `flush()` 是幂等的：按 `getEntries()` 的下标增量追加，重复调用只写新增部分。调用点放在
 * 一轮结束（正常 / 出错 / 中断）与手动压缩之后，因此崩溃最多丢掉「正在跑的那一轮」，
 * 与 Profer 自己的 JSONL 落盘粒度同量级。
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FileEntry, SessionHeader, SessionManager } from '@earendil-works/pi-coding-agent'

/** 需要的最小 SDK 表面；避免在本模块里硬绑动态 import 的结果类型。 */
export interface PiSessionFileSdk {
  SessionManager: {
    inMemory(cwd?: string, options?: { id?: string; parentSession?: string }, entries?: FileEntry[]): SessionManager
  }
  parseSessionEntries(content: string): FileEntry[]
  CURRENT_SESSION_VERSION: number
}

export interface OpenPiSessionFileInput {
  sdk: PiSessionFileSdk
  /** Pi transcript 根目录（会话自己的目录，随项目文件夹走）。 */
  sessionDir: string
  cwd: string
  /** 已解析到的既有 transcript；缺省表示新会话。 */
  existingFile?: string
}

export interface PiSessionFileStore {
  /** SDK 使用的内存态 SessionManager：`persist=false`，SDK 不会写任何文件。 */
  readonly sessionManager: SessionManager
  readonly sessionId: string
  /** 正式文件路径；新会话在 open 时就已写入 header。 */
  readonly file: string
  /** 把 SDK 内存里新增的 entry 追加到正式文件；返回本次写入条数。 */
  flush(): number
  /** 已写入文件的 entry 条数（不含 header）。 */
  readonly writtenEntryCount: number
}

function isAssistantEntry(entry: FileEntry): boolean {
  if (entry.type !== 'message') return false
  const role = (entry as { message?: { role?: unknown } }).message?.role
  return role === 'assistant'
}

function headerLine(header: SessionHeader): string {
  return `${JSON.stringify(header)}\n`
}

/** 用统一的时间戳命名规则生成文件名（与 SDK 一致；查找只认 header.id，不依赖名字）。 */
function fileNameFor(sessionId: string, now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}_${sessionId}.jsonl`
}

/**
 * 打开（或新建）一个由 Profer 独占写入的 Pi session。
 *
 * - 既有文件：解析 entry 后交给 `SessionManager.inMemory`，SDK 完全不写盘；
 * - 新会话：由 SDK 生成 session id（uuidv7 规则），Profer 立刻写入 header，
 *   保证 `piSessionFile` 元数据永远指向一个真实存在的文件；
 * - 旧版本文件：SDK 会在内存里做迁移（id/parentId 可能是随机生成的），
 *   迁移后的内存态必须回写文件，否则下一轮重新解析会生成另一套 id、祖先链直接断掉。
 */
export function openPiSessionFile(input: OpenPiSessionFileInput): PiSessionFileStore {
  const { sdk, sessionDir, cwd } = input
  let file = input.existingFile
  let entries: FileEntry[] = []
  /** 迁移前的版本号：SDK 会在内存里把旧文件升级，必须据此决定是否回写。 */
  let storedVersion: number | undefined

  if (file) {
    let raw = ''
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      throw new Error(`读取 Pi session 失败: ${error instanceof Error ? error.message : String(error)}`)
    }
    entries = raw.trim() ? sdk.parseSessionEntries(raw) : []
    storedVersion = (entries[0] as { version?: number } | undefined)?.version
    if (entries.length > 0 && entries[0]?.type !== 'session') {
      // 与 SDK `_setSessionFile` 同义：非 Pi session 的文件不能当成 resume 目标。
      throw new Error(`Pi session 文件缺少 session header: ${file}`)
    }
  }

  const sessionManager = file && entries.length > 0
    ? sdk.SessionManager.inMemory(cwd, {}, [...entries])
    : sdk.SessionManager.inMemory(cwd)

  const header = sessionManager.getHeader()
  if (!header) throw new Error('Pi session header 缺失，无法建立 transcript')
  const sessionId = sessionManager.getSessionId()

  if (!file) {
    if (!statSafeIsDirectory(sessionDir)) mkdirSync(sessionDir, { recursive: true })
    file = join(sessionDir, fileNameFor(sessionId, new Date()))
    writeFileSync(file, headerLine(header), { encoding: 'utf8', mode: 0o600 })
  } else if (storedVersion !== undefined && storedVersion !== sdk.CURRENT_SESSION_VERSION) {
    // 迁移只在内存里发生（persist=false 不会回写）：立刻把迁移结果落盘，
    // 否则下一次 parse 会再生成一套随机 id，祖先链断裂。
    rewriteFile(file, header, sessionManager.getEntries())
  }

  let written = sessionManager.getEntries().length
  return {
    sessionManager,
    sessionId,
    file,
    get writtenEntryCount() { return written },
    flush(): number {
      const current = sessionManager.getEntries()
      // SDK 语义：会话里还没有 assistant 消息时先不落盘。
      if (!current.some(isAssistantEntry)) return 0
      if (current.length <= written) return 0
      const pending = current.slice(written)
      appendFileSync(file!, pending.map((entry) => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 })
      written = current.length
      return pending.length
    },
  }
}

function rewriteFile(file: string, header: SessionHeader, entries: readonly FileEntry[]): void {
  writeFileSync(
    file,
    `${headerLine(header)}${entries.map((entry) => `${JSON.stringify(entry)}\n`).join('')}`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

function statSafeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
