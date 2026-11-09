/**
 * Pi transcript 回退：把 Pi session 文件重建到「保留历史」的样子。
 *
 * ## 为什么可以「重建」而不是「事后修补」
 *
 * 从 Profer 独占写入（`pi/session-file-store.ts`）开放后，Pi 文件不再由 SDK 边跑边写：
 * SDK 只跑内存态会话，正式文件由 Profer 在本轮结束时按 entry 顺序追加。于是文件内容
 * 恒等于「Profer 自己写过的 entry」，回退只需要按保留历史重写文件，不再需要
 * 「截断后比对条数、不符就整份还原」这类事后修补——那种设计会让同一个事实有两份来源。
 *
 * ## 截断语义（不是分支）
 *
 * Pi SDK 的 `SessionManager.branch(entryId)` 只改内存 leaf 指针、不落盘；entry 本身不可改
 * 也不可删（append-only），而 `open()` 的 `_buildIndex()` 会把 leaf 指向文件最后一条 entry。
 * 因此回退必须把文件本身重写成「header + root→目标 entry 的祖先链」：
 * - 只保留 header（回到会话起点）；
 * - 或只保留目标 entry 的祖先链（沿 parentId 回溯到根，按文件原顺序写回）。
 *
 * ## 失败语义
 *
 * 找不到 session 文件、header 不可解析、entry 不在文件里、祖先链断裂或成环 → 返回
 * `{ ok: false, reason }`，主文件保持原样。调用方必须把 `ok: false` 当失败处理，
 * 不能当成「没有可回退内容」静默继续。写入用「临时文件 + rename」原子替换，
 * 任何一步失败都不会留下半截 transcript。
 *
 * ## 为什么不再整份备份
 *
 * 备份是「修改别人写的文件」的保险。文件现在完全由 Profer 写入，Profer JSONL 是唯一
 * 事实源；留一份 Pi 副本只会制造第二份真相，并在会话目录里堆积垃圾。
 * 结构异常（header 缺失 / 祖先链断裂 / 环）在写盘之前就会失败，主文件原样保留。
 */

import { closeSync, existsSync, openSync, readSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/** 递归扫描的最大目录深度：Pi 按 cwd 分子目录存放，异常数据/错误挂载不能把进程拖死。 */
const SESSION_SCAN_MAX_DEPTH = 24
const SESSION_HEADER_TYPE = 'session'
const HEADER_PROBE_BYTES = 4096

export interface PiTranscriptRewindResult {
  ok: boolean
  file?: string
  kept?: number
  removed?: number
  reason?: string
  /** 重建后保留的**对话消息**条目数（message + user/assistant/toolResult），仅用于日志。 */
  keptMessages?: number
}

interface PiTranscriptEntry {
  id: string
  parentId: string | null
  /** 该 entry 在文件中的行号（0 起）。 */
  lineIndex: number
  /** entry.type，只用于统计「对话消息」与排查原因。 */
  entryType?: string
  /** `message` entry 的 message.role。 */
  messageRole?: string
}

/**
 * Pi 里真正参与 LLM 上下文的对话消息角色。
 *
 * `system` 是 Pi 自己落盘的结构化系统提示（Profer JSONL 不保存它），compaction / branch_summary /
 * custom_message / label / model_change / thinking_level_change 也都不是「对话消息」。
 */
const PI_CONVERSATION_ROLES = new Set(['user', 'assistant', 'toolResult'])

function isConversationEntry(entry: { entryType?: string; messageRole?: string }): boolean {
  return entry.entryType === 'message' && entry.messageRole !== undefined && PI_CONVERSATION_ROLES.has(entry.messageRole)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 只读文件开头，避免为识别 header 把整份 transcript（可能很大）读进内存。 */
function readFirstLine(file: string): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(HEADER_PROBE_BYTES)
    const bytes = readSync(fd, buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, bytes).toString('utf8')
    const newline = text.indexOf('\n')
    return newline < 0 ? text : text.slice(0, newline)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* 关闭失败不改变结论 */ }
    }
  }
}

function scanForSessionFile(directory: string, sdkSessionId: string, depth: number): string | undefined {
  if (depth > SESSION_SCAN_MAX_DEPTH) return undefined
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const candidate = join(directory, entry.name)
    if (entry.isDirectory()) {
      const found = scanForSessionFile(candidate, sdkSessionId, depth + 1)
      if (found) return found
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const headerLine = readFirstLine(candidate)
    if (!headerLine) continue
    try {
      const header = JSON.parse(headerLine) as { type?: unknown; id?: unknown }
      if (header?.type === SESSION_HEADER_TYPE && header.id === sdkSessionId) return candidate
    } catch {
      // 非 Pi JSONL 或首行损坏的文件不能作为回退目标。
    }
  }
  return undefined
}

/**
 * 按 session header 里的 `id` 定位 Pi session 文件。
 *
 * 刻意不用文件名匹配：Pi 文件名是 `<时间戳>_<id>.jsonl`，且按 cwd 分目录存放，
 * 同一 id 可能出现在不同子目录。只认首行 header 才能保证截断的是真正的 resume 目标。
 */
export function findPiSessionFile(sessionDir: string, sdkSessionId: string): string | undefined {
  if (!sessionDir || !sdkSessionId || !existsSync(sessionDir)) return undefined
  return scanForSessionFile(sessionDir, sdkSessionId, 0)
}

interface ParsedTranscript {
  headerLine: string
  /** 文件顺序的原始 entry 行（含坏行占位之前的空行已剔除）。 */
  lines: string[]
  entries: PiTranscriptEntry[]
  /** 无法解析的行数：跳过但不能让它们毁掉整个文件。 */
  badLines: number
}

function parseTranscript(raw: string): { ok: true; value: ParsedTranscript } | { ok: false; reason: string } {
  const lines = raw.split('\n')
  const headerIndex = lines.findIndex((line) => line.trim().length > 0)
  if (headerIndex < 0) return { ok: false, reason: 'Pi session 文件为空' }
  const headerLine = lines[headerIndex]!
  let header: { type?: unknown } | undefined
  try {
    header = JSON.parse(headerLine) as { type?: unknown }
  } catch {
    return { ok: false, reason: 'Pi session 文件首行不是合法 JSON，拒绝截断' }
  }
  if (header?.type !== SESSION_HEADER_TYPE) {
    return { ok: false, reason: 'Pi session 文件缺少 session header，拒绝截断' }
  }

  const entryLines: string[] = []
  const entries: PiTranscriptEntry[] = []
  const seen = new Set<string>()
  let badLines = 0
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.trim().length === 0) continue
    let parsed: { id?: unknown; parentId?: unknown; type?: unknown; message?: { role?: unknown } }
    try {
      parsed = JSON.parse(line) as { id?: unknown; parentId?: unknown; type?: unknown; message?: { role?: unknown } }
    } catch {
      badLines += 1
      continue
    }
    const id = typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : undefined
    if (!id || seen.has(id)) {
      // 没有 id 或 id 重复的 entry 无法参与祖先链，按坏行处理（保留不写回）。
      badLines += 1
      continue
    }
    seen.add(id)
    entryLines.push(line)
    entries.push({
      id,
      parentId: typeof parsed.parentId === 'string' && parsed.parentId.length > 0 ? parsed.parentId : null,
      lineIndex: entryLines.length - 1,
      ...(typeof parsed.type === 'string' ? { entryType: parsed.type } : {}),
      ...(typeof parsed.message?.role === 'string' ? { messageRole: parsed.message.role } : {}),
    })
  }
  return { ok: true, value: { headerLine, lines: entryLines, entries, badLines } }
}

function collectAncestorChain(
  entries: PiTranscriptEntry[],
  entryId: string | null,
): { ok: true; keep: Set<string> } | { ok: false; reason: string } {
  if (entryId === null) return { ok: true, keep: new Set() }
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  if (!byId.has(entryId)) {
    return { ok: false, reason: `Pi session 中找不到 entry ${entryId}` }
  }
  const keep = new Set<string>()
  let cursor: string | null = entryId
  while (cursor) {
    if (keep.has(cursor)) return { ok: false, reason: `Pi session entry ${cursor} 的祖先链存在环` }
    const entry = byId.get(cursor)
    // 祖先缺失 = 该 entry 所在行无法解析或已被清理：继续截断会静默丢掉上下文。
    if (!entry) return { ok: false, reason: `Pi session entry ${cursor} 的祖先链断裂` }
    keep.add(cursor)
    cursor = entry.parentId
  }
  return { ok: true, keep }
}

/**
 * 把 Pi session 文件截断到 `entryId` 的祖先链。
 *
 * @param input.entryId `null` 表示回到会话开始（只保留 header）。
 */
export function rewindPiTranscript(input: {
  piSessionDir: string
  sdkSessionId: string
  /** `null` 表示回到会话开始（只保留 header）。 */
  entryId: string | null
}): PiTranscriptRewindResult {
  const file = findPiSessionFile(input.piSessionDir, input.sdkSessionId)
  if (!file) return { ok: false, reason: `未找到 Pi session 文件: ${input.sdkSessionId}` }

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, reason: `读取 Pi session 失败: ${errorMessage(error)}` }
  }

  const parsed = parseTranscript(raw)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const { headerLine, lines, entries, badLines } = parsed.value

  const chain = collectAncestorChain(entries, input.entryId)
  if (!chain.ok) return { ok: false, reason: chain.reason }

  const keptLines: string[] = [headerLine]
  let kept = 0
  let keptMessages = 0
  for (const entry of entries) {
    if (!chain.keep.has(entry.id)) continue
    keptLines.push(lines[entry.lineIndex]!)
    kept += 1
    if (isConversationEntry(entry)) keptMessages += 1
  }

  const removed = entries.length - kept + badLines
  const nextContent = `${keptLines.join('\n')}\n`
  if (nextContent === raw) {
    // 已经是目标状态：不写、不备份，避免无意义的磁盘写入。
    return { ok: true, file, kept, removed: 0, keptMessages }
  }

  const temp = `${file}.rewind-${process.pid}-${randomUUID()}.tmp`
  try {
    let mode: number | undefined
    try { mode = statSync(file).mode & 0o777 } catch { mode = undefined }
    writeFileSync(temp, nextContent, mode === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', mode })
    renameSync(temp, file)
  } catch (error) {
    try { if (existsSync(temp)) unlinkSync(temp) } catch { /* 清理失败不影响结论 */ }
    return { ok: false, reason: `写入 Pi session 失败: ${errorMessage(error)}` }
  }

  return { ok: true, file, kept, removed, keptMessages }
}
