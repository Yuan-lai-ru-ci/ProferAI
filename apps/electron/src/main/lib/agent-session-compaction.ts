/**
 * 历史会话存储「整理」——把已落盘的过大载荷**搬出 JSONL 行**，而不是删掉。
 *
 * 与截断式迁移的区别（这是本模块存在的全部意义）：
 * - 旧版：超出上限的内容直接截断丢弃，只留 2000 字预览。**数据永久丢失。**
 * - 现在：原文完整搬到 blob（内容寻址存储），行内只留片段与引用，**可完整还原**。
 *
 * 用户 2026-09-17 明确否掉了截断路线：
 * > 不应该为了读取速度而丢失掉部分较长的数据，而应该改变的是存放规则，从而加快读取速度
 *
 * 与写入路径的关系：本模块**不自己实现外部化**，而是调用
 * `agent-session-manager.externalizeSerializedSessionLine`。写入路径与整理路径共用同一个
 * 入口——历史上「同一套规则散在多处、各自漏一处」已经造成过一次事故（落盘截断的 4 个
 * 覆盖缺口），这里不重蹈。截断仍作为兜底保留在该函数内部（抽不动或 blob 写失败时使用）。
 *
 * 安全约束：
 * 1. 只改超限行，其余行逐字节原样保留（按 `\n` 切分再拼回，不动换行风格）。
 * 2. 改写前整份备份到 `<configDir>/migrations/backup-<时间戳>/`。
 * 3. 先写 `<file>.compact-tmp`，成功后 `rename` 原子替换——中途中断不会留下半个文件。
 * 4. 读取后、替换前各测一次文件大小：期间被追加（app 正在写该会话）就放弃这个文件，
 *    避免把并发追加的内容吞掉。
 * 5. 单个文件出错只记录并继续，不中断整轮。
 *
 * 闸门：用**内容自闸**（扫到超限行才动手）而不是版本标记文件。标记会失配——用户从
 * 备份恢复旧文件后标记仍在，就永远不会再整理。自闸不存在这种漏网，代价只是一次扫描。
 *
 * 为什么是异步：由用户在设置页触发，真机全量约数秒。同步 fs 会把主进程进而整个 UI
 * 卡住；异步 fs 在 I/O 之间让出事件循环。逐行外部化本身是同步的（与写入路径共用同一
 * 实现），因此在行与行之间显式让出一次，避免单个会话文件长时间独占主线程。
 */

import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getConfigDir } from './config-paths'
import { listAllSessionMessageFiles } from './session-data-layout'
import {
  MAX_SDK_MESSAGE_LENGTH,
  externalizeSerializedSessionLine,
  readSerializedBlobRefs,
} from './session-payload-externalize'

export interface SessionCompactionResult {
  /** 扫描的会话文件数 */
  scannedFiles: number
  /** 实际被改写的文件数 */
  rewrittenFiles: number
  /** 被改写的行数 */
  rewrittenLines: number
  /** 因期间被并发追加而跳过的文件数 */
  skippedFiles: number
  /** 处理失败的文件数（错误见 errors） */
  failedFiles: number
  /** 被改写行的整理前字符数 */
  charsBefore: number
  /** 被改写行的整理后字符数（行内） */
  charsAfter: number
  /** 本次搬进独立存储的载荷条数（含重复引用） */
  blobRefs: number
  /** 本次搬进独立存储的**不同**载荷数（内容寻址 ⇒ 同内容只写一份） */
  blobCount: number
  /** 本次写入的载荷总字节数 */
  blobBytes: number
  /** 备份目录（本次无改写时为 undefined） */
  backupDir?: string
  /** 逐文件错误信息（最多保留 20 条，避免异常时刷屏） */
  errors: string[]
}

const TMP_SUFFIX = '.compact-tmp'
const MAX_RECORDED_ERRORS = 20

function createEmptyResult(): SessionCompactionResult {
  return {
    scannedFiles: 0,
    rewrittenFiles: 0,
    rewrittenLines: 0,
    skippedFiles: 0,
    failedFiles: 0,
    charsBefore: 0,
    charsAfter: 0,
    blobRefs: 0,
    blobCount: 0,
    blobBytes: 0,
    errors: [],
  }
}

async function ensureBackupDir(result: SessionCompactionResult): Promise<string> {
  if (result.backupDir) return result.backupDir
  const dir = join(getConfigDir(), 'migrations', `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  await mkdir(dir, { recursive: true })
  result.backupDir = dir
  return dir
}

function recordError(result: SessionCompactionResult, name: string, error: unknown): void {
  result.failedFiles++
  if (result.errors.length < MAX_RECORDED_ERRORS) {
    result.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 让出一次事件循环，避免单个会话文件长时间独占主线程 */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** 把一行搬去独立存储，并把本次写入的载荷计入统计 */
function externalizeLineIntoStats(
  line: string,
  sessionName: string,
  result: SessionCompactionResult,
  seenHashes: Set<string>,
): string {
  const compacted = externalizeSerializedSessionLine(line, sessionName)
  if (compacted === line) return line

  for (const ref of readSerializedBlobRefs(compacted)) {
    result.blobRefs++
    if (seenHashes.has(ref.hash)) continue          // 内容寻址 ⇒ 同内容只写一份
    seenHashes.add(ref.hash)
    result.blobCount++
    result.blobBytes += ref.bytes || 0
  }
  return compacted
}

/**
 * 仅统计不写入：用于先给用户看「整理能省多少」再决定是否执行。
 */
export async function previewAgentSessionCompaction(): Promise<SessionCompactionResult> {
  const result = createEmptyResult()
  const seenHashes = new Set<string>()

  for (const file of listAllSessionMessageFiles()) {
    result.scannedFiles++
    try {
      if ((await stat(file.path)).size <= MAX_SDK_MESSAGE_LENGTH) continue

      const lines = (await readFile(file.path, 'utf-8')).split('\n')
      let touched = false
      for (const line of lines) {
        if (line.length <= MAX_SDK_MESSAGE_LENGTH) continue
        const compacted = externalizeLineIntoStats(line, file.sessionId, result, seenHashes)
        if (compacted === line) continue
        touched = true
        result.rewrittenLines++
        result.charsBefore += line.length
        result.charsAfter += compacted.length
      }
      if (touched) result.rewrittenFiles++
    } catch (error) {
      recordError(result, file.sessionId, error)
    }
  }

  return result
}

/**
 * 就地整理所有会话文件里的超限行。幂等：没有超限行时不做任何写入。
 */
export async function compactAgentSessionStorage(): Promise<SessionCompactionResult> {
  const result = createEmptyResult()
  const seenHashes = new Set<string>()

  for (const file of listAllSessionMessageFiles()) {
    const filePath = file.path
    result.scannedFiles++

    try {
      // UTF-8 下字节数 ≥ 字符数，所以文件总字节数不超过上限时，不可能存在超限行。
      // 这一步让绝大多数小文件免于读取。
      const sizeBeforeRead = (await stat(filePath)).size
      if (sizeBeforeRead <= MAX_SDK_MESSAGE_LENGTH) continue

      const lines = (await readFile(filePath, 'utf-8')).split('\n')
      const compactedLines: string[] = []
      let fileChanged = false
      let fileLinesRewritten = 0
      let fileCharsBefore = 0
      let fileCharsAfter = 0

      for (const line of lines) {
        if (line.length <= MAX_SDK_MESSAGE_LENGTH) {
          compactedLines.push(line)
          continue
        }
        // 逐行外部化是同步的（与写入路径共用同一实现）；行与行之间让出一次，
        // 避免一个塞满巨型行的会话文件长时间卡住主进程。
        await yieldToEventLoop()
        const compacted = externalizeLineIntoStats(line, file.sessionId, result, seenHashes)
        if (compacted === line) {
          compactedLines.push(line)
          continue
        }
        fileChanged = true
        fileLinesRewritten++
        fileCharsBefore += line.length
        fileCharsAfter += compacted.length
        compactedLines.push(compacted)
      }

      if (!fileChanged) continue

      // 并发保护：读取期间文件被追加说明 app 正在写这个会话，本轮放过它。
      if ((await stat(filePath)).size !== sizeBeforeRead) {
        result.skippedFiles++
        continue
      }

      const backupDir = await ensureBackupDir(result)
      await copyFile(filePath, join(backupDir, `${file.sessionId}.jsonl`))

      const tmpPath = filePath + TMP_SUFFIX
      await writeFile(tmpPath, compactedLines.join('\n'), 'utf-8')
      await rename(tmpPath, filePath)

      result.rewrittenFiles++
      result.rewrittenLines += fileLinesRewritten
      result.charsBefore += fileCharsBefore
      result.charsAfter += fileCharsAfter
    } catch (error) {
      recordError(result, file.sessionId, error)
      // 失败时清掉可能残留的临时文件，避免污染会话目录
      try {
        await rm(filePath + TMP_SUFFIX, { force: true })
      } catch {
        // 清理失败不覆盖原始错误
      }
    }
  }

  return result
}
