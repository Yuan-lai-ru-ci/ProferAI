/**
 * 会话落盘的载荷收敛：超限行截断、大字符串外部化到 blob，以及引用表读取。
 *
 * 写入路径（agent-session-manager 的 appendSDKMessages）与存量整理（agent-session-compaction）
 * 共用这里的入口。还原（resolveMessageBlobs）仍在 manager，因为它需要 blob 读取。
 */
import type { SDKMessage } from '@profer/shared'
import { SESSION_BLOB_REFS_FIELD, SESSION_BLOB_MISSING_FIELD, readSessionBlobRefs } from '@profer/shared'
import { writeBlobSync } from './blob-store'

/** 单条 SDKMessage 序列化后最大长度（UTF-16 code units，超出则截断内容） */
/** 落盘规则：单条消息序列化后的字符上限。写入路径与存量迁移共用此常量。 */
export const MAX_SDK_MESSAGE_LENGTH = 256 * 1024 // ~256K chars
/** 截断后保留的预览文本长度 */
const TRUNCATED_PREVIEW_LENGTH = 2000

/**
 * 按落盘规则收敛一条**已序列化**的会话行；未超限则原样返回。
 *
 * 写入路径（`appendSDKMessages` / `serializeSDKMessageForStorage`）与存量迁移
 * （`oversized-session-migration`）共用这一个入口。此前同一套规则散在两处内联，
 * 正是「各自漏一处」的温床——补 4 个覆盖缺口时已吃过一次这个亏。
 */
export function sanitizeSerializedSessionLine(line: string, sessionId?: string): string {
  if (line.length <= MAX_SDK_MESSAGE_LENGTH) return line

  let message: SDKMessage
  try {
    message = JSON.parse(line) as SDKMessage
  } catch {
    // 损坏行不在这里处理（迁移侧会记为 skipped）；原样返回，避免二次破坏
    return line
  }

  const sanitized = JSON.stringify(sanitizeOversizedMessage(message, line.length))
  if (sanitized.length > MAX_SDK_MESSAGE_LENGTH) {
    console.warn(
      `[Agent 会话] 消息截断后仍超限 (${(sanitized.length / 1024).toFixed(0)}K chars)${sessionId ? `, session=${sessionId}` : ''}`,
    )
  }
  return sanitized
}

// ===== 大载荷外部化（把载荷搬出 JSONL 行，而不是删掉） =====

/**
 * 消息级引用表字段名。放在消息顶层，不影响任何已有字段。
 * 为什么不把字段本身换成对象：那会把类型从 string 变成联合类型，
 * 老版本读到新数据会渲染成 `[object Object]` 甚至崩；
 * 保持 string（值为片段）则老代码只是显示得短一点——降级而非崩坏。
 */
export const BLOB_REFS_FIELD = SESSION_BLOB_REFS_FIELD
/** 还原失败时记录缺失引用，供上层提示「原文不可用」 */
export const BLOB_REFS_MISSING_FIELD = SESSION_BLOB_MISSING_FIELD

/** 第一级：行内保留的片段长度（与截断预览同长） */
const INLINE_PREVIEW_CHARS = TRUNCATED_PREVIEW_LENGTH
/**
 * 第一级可抽取下限。短于片段长度的字符串抽了等于没抽（片段就是全文），因此第一级不碰。
 * 同时也是第一级「抽不动了」的终止条件：候选已按长度降序，遇到不达下限的就必然全部不达标。
 */
const FIRST_TIER_MIN_CHARS = INLINE_PREVIEW_CHARS
/**
 * 第二级片段长度：第一级抽完仍超限时，把中等字符串也抽走，只留更短的片段。
 *
 * 存在一个真实形态会让第一级无解：**一个工具返回大量（约 150~200 条以上）结构化记录，
 * 每条带一个约 1500 字符的字段**，而整条消息里没有任何字符串超过 2000。
 * 真机的委派列表工具已出现过 25 条记录的实例（每条 resultSummary 3K~12K），
 * 规模再大一个数量级即命中——见工作包 design.md 第 11 节。
 *
 * 抽走之后原文仍在 blob，不丢数据；代价只是片段更短，折叠态可读性下降。
 */
const SHORT_PREVIEW_CHARS = 200
const SECOND_TIER_MIN_CHARS = 512
/** 遍历深度上限，防止异常结构导致栈过深 */
const MAX_BLOB_WALK_DEPTH = 12

export interface StoredBlobRef {
  /** 相对消息根的对象路径，如 `tool_use_result.content.0.text` */
  path: string
  hash: string
  chars: number
  bytes: number
}

interface ExtractableString {
  path: string
  length: number
}

/** 路径 tokenizer：`a.b[0].c` → ['a','b',0,'c'] */
function tokenizeBlobPath(path: string): (string | number)[] {
  const tokens: (string | number)[] = []
  const pattern = /([^.[\]]+)|\[(\d+)\]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(path)) !== null) {
    tokens.push(match[2] !== undefined ? Number(match[2]) : match[1]!)
  }
  return tokens
}

function getStringAtPath(root: unknown, path: string): string | undefined {
  let node: unknown = root
  for (const token of tokenizeBlobPath(path)) {
    if (typeof token === 'number') {
      if (!Array.isArray(node)) return undefined
      node = node[token]
    } else {
      if (!isPlainRecord(node)) return undefined
      node = node[token]
    }
  }
  return typeof node === 'string' ? node : undefined
}

export function setStringAtPath(root: unknown, path: string, value: string): boolean {
  const tokens = tokenizeBlobPath(path)
  if (tokens.length === 0) return false
  let node: unknown = root
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i]!
    if (typeof token === 'number') {
      if (!Array.isArray(node)) return false
      node = node[token]
    } else {
      if (!isPlainRecord(node)) return false
      node = node[token]
    }
  }
  const last = tokens[tokens.length - 1]!
  if (typeof last === 'number') {
    if (!Array.isArray(node)) return false
    node[last] = value
    return true
  }
  if (!isPlainRecord(node)) return false
  node[last] = value
  return true
}

/**
 * 递归收集超过 `minChars` 的字符串及其路径（不进入引用表自身，跳过已抽过的路径）。
 * 已抽过的路径必须跳过：第一级留下的片段（2000 字）仍 ≥ 第二级下限，
 * 不跳就会被第二级再抽一遍，把片段也搬走。
 */
function collectExtractableStrings(
  value: unknown,
  path: string,
  out: ExtractableString[],
  minChars: number,
  skipPaths: Set<string>,
  includeSkipped = false,
  depth = 0,
): void {
  if (depth > MAX_BLOB_WALK_DEPTH) return

  if (typeof value === 'string') {
    if (value.length > minChars && (includeSkipped || !skipPaths.has(path))) out.push({ path, length: value.length })
    return
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      collectExtractableStrings(value[i], `${path}[${i}]`, out, minChars, skipPaths, includeSkipped, depth + 1)
    }
    return
  }
  if (!isPlainRecord(value)) return

  for (const [key, child] of Object.entries(value)) {
    if (key === BLOB_REFS_FIELD || key === BLOB_REFS_MISSING_FIELD) continue
    collectExtractableStrings(child, path ? `${path}.${key}` : key, out, minChars, skipPaths, includeSkipped, depth + 1)
  }
}

/**
 * 把消息连同引用表一起序列化。
 *
 * 判定预算时【必须】带上引用表：否则循环会在「消息刚好落回上限」时停下，
 * 而附加上引用表后又挠出去几十条引用的大小，最终校验失败导致整个外部化被丢弃。
 */
function serializeMessageWithRefs(message: Record<string, unknown>, refs: StoredBlobRef[]): string {
  return refs.length === 0 ? JSON.stringify(message) : JSON.stringify({ ...message, [BLOB_REFS_FIELD]: refs })
}

/**
 * 按给定片段长度与下限，从最大的字符串开始抽，直到（含引用表）落回行预算内。
 * 返回是否达标，以及达标时可直接落盘的序列化结果。
 */
function extractUntilUnderBudget(
  message: Record<string, unknown>,
  refs: StoredBlobRef[],
  extractedPaths: Set<string>,
  fragmentChars: number,
  minChars: number,
  sessionId?: string,
  allowExistingRefs = false,
): { converged: boolean; serialized: string } {
  let serialized = serializeMessageWithRefs(message, refs)
  if (serialized.length <= MAX_SDK_MESSAGE_LENGTH) return { converged: true, serialized }

  const candidates: ExtractableString[] = []
  collectExtractableStrings(message, '', candidates, minChars, extractedPaths, allowExistingRefs)
  if (candidates.length === 0) return { converged: false, serialized }
  candidates.sort((a, b) => b.length - a.length)

  for (const candidate of candidates) {
    if (serialized.length <= MAX_SDK_MESSAGE_LENGTH) return { converged: true, serialized }

    const value = getStringAtPath(message, candidate.path)
    if (typeof value !== 'string' || value.length <= minChars) break

    const existingRef = allowExistingRefs ? refs.find((ref) => ref.path === candidate.path) : undefined
    if (existingRef) {
      if (!setStringAtPath(message, candidate.path, value.slice(0, fragmentChars))) break
    } else {
      const { hash, bytes } = writeBlobSync(value, sessionId)
      if (!setStringAtPath(message, candidate.path, value.slice(0, fragmentChars))) break
      extractedPaths.add(candidate.path)
      refs.push({ path: candidate.path, hash, chars: value.length, bytes })
    }
    serialized = serializeMessageWithRefs(message, refs)
  }

  return { converged: serialized.length <= MAX_SDK_MESSAGE_LENGTH, serialized }
}

/**
 * 把超限行里的超大字符串搬到 blob，行内只留片段 + 引用。
 *
 * 规则（用户 2026-09-17 确认）：
 * 1. 行未超限 → 原样返回，**一个字节都不动**
 * 2. 超了 → 从最大字符串开始抽，原位留前 2000 字片段，再量一次，还超就继续抽
 * 3. 抽不动了（候选已不足片段长度）或 blob 写失败 → 退回截断兜底
 *
 * 为什么「从最大开始抽」：抽一个 12 MB 的字符串就解决问题，不需要动其他字段，干预面最小。
 */
export function externalizeSerializedSessionLine(
  line: string,
  sessionId?: string,
  options: { strict?: boolean } = {},
): string {
  if (line.length <= MAX_SDK_MESSAGE_LENGTH) return line

  let message: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(line)
    if (!isPlainRecord(parsed)) {
      if (options.strict) throw new Error('会话行根值不是对象')
      return sanitizeSerializedSessionLine(line, sessionId)
    }
    message = parsed
  } catch (error) {
    if (options.strict) throw error
    return sanitizeSerializedSessionLine(line, sessionId)
  }

  const refs: StoredBlobRef[] = []
  const extractedPaths = new Set<string>()
  try {
    // 第一级：只抽明显的大字符串（≥ 2000），片段长度也是 2000
    let { converged, serialized } = extractUntilUnderBudget(
      message, refs, extractedPaths, INLINE_PREVIEW_CHARS, FIRST_TIER_MIN_CHARS, sessionId,
    )

    // 第二级：第一级无解时（典型形态：一条消息里全是中等字符串，无一超过 2000）
    // 把中等字符串也抽走，只留更短的片段——原文仍在 blob，不丢数据
    if (!converged) {
      ;({ converged, serialized } = extractUntilUnderBudget(
        message, refs, extractedPaths, SHORT_PREVIEW_CHARS, SECOND_TIER_MIN_CHARS, sessionId, true,
      ))
    }

    // 达标且确实搬走了东西 → 直接用（serialized 已含引用表，无需再拼一次）
    if (converged && refs.length > 0) return serialized

    if (options.strict) throw new Error(`会话行外部化无法在预算内完整收敛${sessionId ? `: ${sessionId}` : ''}`)
    return sanitizeSerializedSessionLine(line, sessionId)
  } catch (error) {
    if (options.strict) throw error
    // blob 写失败不能让旧同步写入路径崩溃：退回截断，保住行上限。
    console.warn(`[Agent 会话] 载荷外部化失败，退回截断${sessionId ? ` session=${sessionId}` : ''}:`, error)
    return sanitizeSerializedSessionLine(line, sessionId)
  }
}

/**
 * 从一条**已序列化**的会话行里读出引用表。
 * 供存量迁移统计「本次搬了多少载荷」使用；解析失败返回空数组（不抛异常）。
 * 复用 shared 的 readSessionBlobRefs，避免同一形状在两处各自实现。
 */
export function readSerializedBlobRefs(line: string): StoredBlobRef[] {
  try {
    return readSessionBlobRefs(JSON.parse(line)) as StoredBlobRef[]
  } catch {
    return []
  }
}

/** 递归收敛 tool_use_result 时的最大深度，防止异常结构导致栈过深 */
const MAX_TOOL_RESULT_SANITIZE_DEPTH = 8

/**
 * 逐级收紧时的字符串阈值下限。
 * 低于它就不再继续收紧，避免把正常长度的内容也切碎。
 */
const MIN_SANITIZE_STRING_THRESHOLD = 4000

/** 逐级收紧的最大轮数（128K → 32K → 8K → 4K） */
const MAX_SANITIZE_ATTEMPTS = 4

/** 仅普通对象（排除数组与 null），供结构化载荷遍历使用 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 递归收敛结构化的工具结果载荷。
 *
 * Pi runtime 会把 tool_result 的完整 details 作为顶层 `tool_use_result` 落盘
 * （见 pi-message-adapter.ts），它与 message.content 等量，实测单条最大约 12 MB
 * （整页 HTML、PDF 的 base64、内嵌图片）。这里用与 message.content 同一套规则处理：
 * 超过阈值的字符串截断为预览 + 说明。
 *
 * 渲染侧只有 parseAgentImageAttachmentDetails 会读它，而该函数提取的是
 * localPath / filename / mediaType 这类路径型标记，不依赖超长字符串，因此截断安全。
 */
function sanitizeToolResultPayload(
  payload: unknown,
  truncationThreshold: number,
  truncationNote: string,
  depth = 0,
): unknown {
  if (depth > MAX_TOOL_RESULT_SANITIZE_DEPTH) return payload
  if (typeof payload === 'string') {
    return payload.length > truncationThreshold
      ? payload.slice(0, TRUNCATED_PREVIEW_LENGTH) + truncationNote
      : payload
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => sanitizeToolResultPayload(item, truncationThreshold, truncationNote, depth + 1))
  }
  if (!isPlainRecord(payload)) return payload

  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    sanitized[key] = sanitizeToolResultPayload(value, truncationThreshold, truncationNote, depth + 1)
  }
  return sanitized
}

/**
 * 按给定字符串阈值就地收敛一份消息副本（调用方保证 clone 是可安全修改的深拷贝）。
 * 处理四类膨胀源：超长 text block、超大 tool_result、内嵌 base64 图片、
 * 以及顶层 tool_use_result 副本（message.content 的等量拷贝）。
 */
function applyOversizedSanitization(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  clone: any,
  truncationNote: string,
  truncationThreshold: number,
): SDKMessage {
  // 顶层 tool_use_result 是 tool_result 正文的完整副本，必须与 message.content 同规则处理，
  // 否则即使正文被截断，整行依然超限（实测 161/250 条巨型行涉此，72 条仅副本就超限）。
  if (clone.tool_use_result !== undefined) {
    clone.tool_use_result = sanitizeToolResultPayload(clone.tool_use_result, truncationThreshold, truncationNote)
  }
  if (clone.toolUseResult !== undefined) {
    clone.toolUseResult = sanitizeToolResultPayload(clone.toolUseResult, truncationThreshold, truncationNote)
  }

  const content = clone.message?.content
  if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      const block = content[i]
      if (!block || typeof block !== 'object') continue

      // 截断超长 text block
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > truncationThreshold) {
        block.text = block.text.slice(0, TRUNCATED_PREVIEW_LENGTH) + truncationNote
      }

      // 截断超大 tool_result
      if (block.type === 'tool_result') {
        if (typeof block.content === 'string' && block.content.length > truncationThreshold) {
          block.content = block.content.slice(0, TRUNCATED_PREVIEW_LENGTH) + truncationNote
        }
        if (Array.isArray(block.content)) {
          block.content = block.content.map((item: Record<string, unknown>) => {
            // 剥离 base64 图片数据。两种结构并存：Anthropic 风格 { source: { data } }
            // 与 Pi 风格 { data } —— 后者此前漏处理，实测约 95 MB 未收敛。
            if (item?.type === 'image') {
              const source = item.source as Record<string, unknown> | undefined
              const data = typeof item.data === 'string'
                ? item.data
                : typeof source?.data === 'string'
                  ? String(source.data)
                  : undefined
              if (data) {
                return { type: 'image', _truncated: true, _originalLength: data.length }
              }
            }
            // 嵌套在数组里的 text block 此前不受限，同样按阈值截断
            if (item?.type === 'text' && typeof item.text === 'string' && item.text.length > truncationThreshold) {
              return { ...item, text: item.text.slice(0, TRUNCATED_PREVIEW_LENGTH) + truncationNote }
            }
            return item
          })
        }
      }
    }
  }

  // 截断 error.message
  if (clone.error && typeof clone.error === 'object' && typeof clone.error.message === 'string' && clone.error.message.length > truncationThreshold) {
    clone.error.message = clone.error.message.slice(0, TRUNCATED_PREVIEW_LENGTH) + truncationNote
  }

  return clone as SDKMessage
}

/**
 * 截断超大 SDKMessage 的内容，保留元数据结构。
 *
 * 字符串的“原文长度”与“序列化长度”可能严重不等：含大量控制字符的内容会被 JSON
 * 转义为 \\uXXXX（最多膨胀 6 倍，实测 49K 原文 → 279K JSON）。所以这里不以原文长度
 * 一次定稿，而是按**实际序列化结果**逐级收紧阈值，直到落入上限或到达下限。
 */
function sanitizeOversizedMessage(msg: SDKMessage, originalLength: number): SDKMessage {
  const truncationNote = `\n[内容已截断: 原始 ${(originalLength / 1024).toFixed(0)}K chars 超出存储限制]`

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const original: any = JSON.parse(JSON.stringify(msg))
  let threshold = MAX_SDK_MESSAGE_LENGTH / 2
  let result = applyOversizedSanitization(JSON.parse(JSON.stringify(original)), truncationNote, threshold)

  for (let attempt = 1; attempt < MAX_SANITIZE_ATTEMPTS; attempt++) {
    if (JSON.stringify(result).length <= MAX_SDK_MESSAGE_LENGTH) return result
    if (threshold <= MIN_SANITIZE_STRING_THRESHOLD) return result
    threshold = Math.max(MIN_SANITIZE_STRING_THRESHOLD, Math.floor(threshold / 4))
    result = applyOversizedSanitization(JSON.parse(JSON.stringify(original)), truncationNote, threshold)
  }

  return result
}
