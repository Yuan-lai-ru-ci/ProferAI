/**
 * Pi Agent 消息兼容层。
 *
 * 宿主共享的消息协议保持 Claude SDK 兼容；本模块集中处理
 * Pi AgentMessage 与 SDKMessage 之间的形状转换，避免 session 编排代码混入 UI 协议细节。
 */

import { randomUUID } from 'node:crypto'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai/compat'
import type { SDKMessage, SDKAssistantMessage } from '@profer/shared'
import type { RuntimeGuardResultOverride } from '@profer/agent-runtime'
import { isTransientNetworkError } from '@profer/agent-runtime/error-patterns'
import type {
  PiImageTranscodeOptions,
  PiImageTranscodeResult,
  PiImageTranscoderPort,
  PiToolResultPersistPort,
} from '../ports'

function getPiEditItems(input: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(input.edits)
    ? input.edits.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : []
}

function isMultiEditInput(piName: string, input: Record<string, unknown>): boolean {
  return piName === 'edit' && getPiEditItems(input).length > 1
}

export function displayToolName(piName: string, input?: Record<string, unknown>): string {
  switch (piName) {
    case 'read':
      return 'Read'
    case 'write':
      return 'Write'
    case 'edit':
      return input && isMultiEditInput(piName, input) ? 'MultiEdit' : 'Edit'
    case 'bash':
      return 'Bash'
    case 'grep':
      return 'Grep'
    case 'find':
      return 'Glob'
    case 'ls':
      return 'LS'
    default:
      return piName
  }
}

export function normalizePermissionInput(piName: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (piName) {
    case 'read':
    case 'write':
      return { ...input, file_path: input.path }
    case 'edit': {
      const editItems = getPiEditItems(input)
      const firstEdit = editItems[0]
      return {
        ...input,
        file_path: input.path,
        edits: editItems.map((edit) => ({
          ...edit,
          old_string: edit.old_string ?? edit.oldText,
          new_string: edit.new_string ?? edit.newText,
        })),
        old_string: firstEdit?.old_string ?? firstEdit?.oldText,
        new_string: firstEdit?.new_string ?? firstEdit?.newText,
      }
    }
    case 'find':
      return { ...input, pattern: input.pattern }
    case 'ls':
      return { ...input, file_path: input.path ?? '.' }
    default:
      return input
  }
}

function normalizeToolUseInput(piName: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (piName) {
    case 'read':
    case 'write':
      return { ...input, file_path: input.file_path ?? input.path }
    case 'edit': {
      const editItems = getPiEditItems(input)
      const firstEdit = editItems[0]
      const normalizedEdits = editItems.map((edit) => ({
        ...edit,
        old_string: edit.old_string ?? edit.oldText,
        new_string: edit.new_string ?? edit.newText,
      }))
      const joinedOld = normalizedEdits
        .map((edit, index) => `--- Edit ${index + 1} ---\n${String(edit.old_string ?? '')}`)
        .join('\n')
      const joinedNew = normalizedEdits
        .map((edit, index) => `--- Edit ${index + 1} ---\n${String(edit.new_string ?? '')}`)
        .join('\n')
      return {
        ...input,
        file_path: input.file_path ?? input.path,
        edits: normalizedEdits,
        old_string: input.old_string ?? (normalizedEdits.length > 1 ? joinedOld : firstEdit?.old_string ?? firstEdit?.oldText),
        new_string: input.new_string ?? (normalizedEdits.length > 1 ? joinedNew : firstEdit?.new_string ?? firstEdit?.newText),
      }
    }
    case 'find':
      return { ...input, pattern: input.pattern }
    case 'ls':
      return { ...input, file_path: input.file_path ?? input.path ?? '.' }
    default:
      return input
  }
}

export function restorePiInput(
  piName: string,
  original: Record<string, unknown>,
  updated?: Record<string, unknown>,
): Record<string, unknown> {
  if (!updated) return original
  switch (piName) {
    case 'read':
    case 'write':
      return { ...original, ...updated, path: updated.file_path ?? updated.path ?? original.path }
    case 'edit':
      return { ...original, ...updated, path: updated.file_path ?? updated.path ?? original.path }
    default:
      return { ...original, ...updated }
  }
}

export const EMPTY_IMAGE_PLACEHOLDER_TEXT = '[图像内容不可用：工具返回了空图像数据，已从发送给模型的上下文中移除。请改用文本方式获取信息（例如 BrowserObserve）。]'

/**
 * 工具结果上下文预算。
 *
 * 审计依据（2026-10-19，近 14 天 349 个 Pi 会话、30,716 次模型调用）：
 * 工具结果占上下文字符的 88%，其中 bash/read/grep 是文本大头，inspect_preview
 * 的截图是图片大头。Pi SDK 已按 50KB/2000 行截断单次工具输出，但旧结果会在
 * 后续每次请求里重复进入上下文，长会话因此膨胀到 9 万 token/次以上。
 *
 * 策略：
 * - 文本按历史顺序回放预算，超过 200k 字符时才成批整理旧组；最近两组保持完整。
 *   已整理的表示在后续回放中保持一致，避免每新增一组就重写模型已缓存的前缀。
 * - 图片首次发送采用统一高清档；只有张数/字节超限时才成批降级、移除旧图。
 *   同一段历史重新加载后能重建相同预算决策，不依赖进程内状态。
 * - 宿主注入 imageTranscoder 时，旧图会先降采样/转 JPEG 再发送；没有转码器时
 *   退化为张数裁剪，至少不会把无限图片塞进请求。
 */
const KEEP_RECENT_TOOL_RESULT_GROUPS = 2
/** 单条旧工具结果文本上限（字符）。 */
const MAX_OLD_TOOL_RESULT_TEXT_CHARS = 8_000
/**
 * 一次请求里所有工具结果文本的聚合上限。
 *
 * 单条截断只能管住「某一条特别大」，管不住「十条都不大但加起来撑爆」。
 * 超出后从最旧的组开始落盘，最近组不动。
 */
const MAX_TOTAL_TOOL_RESULT_TEXT_CHARS = 200_000
/** 超限时腾出一半空间，避免后续每次工具调用都重新整理历史。 */
const TARGET_TOOL_RESULT_TEXT_CHARS = MAX_TOTAL_TOOL_RESULT_TEXT_CHARS / 2
/** 落盘后留给模型的预览长度。 */
const PERSISTED_PREVIEW_CHARS = 2_000
/** 落盘预览的固定前缀，用于幂等判断。 */
export const PERSISTED_TOOL_RESULT_PREFIX = '[Profer context budget: 完整输出'
const MAX_CONTEXT_IMAGES = 6
const TARGET_CONTEXT_IMAGES = MAX_CONTEXT_IMAGES / 2
/** 请求中所有工具图片 base64 字符数的总预算（约 4.5MB 原始字节）。 */
const MAX_CONTEXT_IMAGE_BASE64_BYTES = 6 * 1024 * 1024
const TARGET_CONTEXT_IMAGE_BASE64_BYTES = MAX_CONTEXT_IMAGE_BASE64_BYTES / 2
/** 新图统一用高清；仅在总量超限时整理旧图。 */
const HIGH_RES_IMAGE_OPTIONS: PiImageTranscodeOptions = {
  maxSide: 1600,
  quality: 82,
  maxBase64Bytes: 1_500_000,
}
const OLD_IMAGE_OPTIONS: PiImageTranscodeOptions = {
  maxSide: 1024,
  quality: 70,
  maxBase64Bytes: 300_000,
}

export const TOOL_RESULT_BUDGET_MARKER = '[Profer context budget:'
export const OMITTED_TOOL_IMAGE_TEXT = '[Profer context budget: 已省略较早的工具图片以节省上下文；如需查看，请重新调用对应工具。]'

/** 文本预算的宿主能力；persist 缺失或 sessionId 为空时退化为原地截断。 */
export interface PiContextBudgetOptions {
  persist?: PiToolResultPersistPort
  sessionId?: string
}

function formatCharCount(chars: number): string {
  if (chars < 1024) return `${chars} 字符`
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)}K 字符`
  return `${(chars / (1024 * 1024)).toFixed(1)}M 字符`
}

function toolResultTextLength(message: ToolResultMessage): number {
  const content = message.content as unknown
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  return (content as ToolResultBlock[]).reduce(
    (total, block) => total + (block?.type === 'text' && typeof block.text === 'string' ? block.text.length : 0),
    0,
  )
}

function toolResultTextOf(message: ToolResultMessage): string | null {
  const content = message.content as unknown
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const texts = (content as ToolResultBlock[])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
  return texts.length > 0 ? texts.join('\n') : null
}

/** 把结果折叠成一段文本 + 保留图片块，用于落盘预览。 */
function withSingleTextBlock(message: ToolResultMessage, text: string): AgentMessage {
  const content = message.content as unknown
  if (typeof content === 'string') return { ...message, content: text } as unknown as AgentMessage
  const blocks = Array.isArray(content) ? (content as ToolResultBlock[]) : []
  const images = blocks.filter((block) => block?.type === 'image')
  return { ...message, content: [{ type: 'text', text }, ...images] } as unknown as AgentMessage
}

/** 通过端口落盘；没有端口或写失败时返回 null，调用方保持原地截断。 */
function persistToolResultText(text: string, toolCallId: string, options: PiContextBudgetOptions): string | null {
  const { persist, sessionId } = options
  if (!persist || !sessionId) return null
  const trimmed = text.trimStart()
  const isJson = trimmed.startsWith('{') || trimmed.startsWith('[')
  try {
    return persist.persist({ sessionId, toolCallId, text, isJson })?.path ?? null
  } catch {
    return null
  }
}

function buildPersistedPreview(text: string, path: string): string {
  const preview = text.slice(0, PERSISTED_PREVIEW_CHARS)
  return `${PERSISTED_TOOL_RESULT_PREFIX} ${formatCharCount(text.length)} 已保存到 ${path}；以下为前 ${formatCharCount(preview.length)} 预览，其余内容请读取该文件。]\n\n${preview}`
}

function truncateToolResultText(text: string, maxChars: number): string {
  // 压缩后总长度不超过 maxChars，因此长度本身就是幂等判据。
  // 不能用 includes(MARKER) 判断是否已压缩：工具读到含该字面量的文件内容会被误判为
  // 已压缩，导致该结果整条跳过裁剪。
  if (text.length <= maxChars) return text
  const omitted = text.length - maxChars
  const marker = `\n\n${TOOL_RESULT_BUDGET_MARKER} 已省略 ${omitted} 个字符以节省上下文；如仍需完整内容，请重新调用工具或分页读取。]\n\n`
  const budget = maxChars - marker.length
  if (budget <= 0) return text.slice(0, maxChars)
  const headChars = Math.floor(budget * 0.6)
  const tailChars = budget - headChars
  const tail = tailChars > 0 ? text.slice(-tailChars) : ''
  return `${text.slice(0, headChars)}${marker}${tail}`
}

function budgetToolResultText(content: unknown, maxTextChars: number | null): unknown | null {
  if (maxTextChars === null) return null

  if (typeof content === 'string') {
    const truncated = truncateToolResultText(content, maxTextChars)
    return truncated === content ? null : truncated
  }

  if (!Array.isArray(content)) return null

  const blocks = content as Array<Record<string, unknown>>
  const textBlocks = blocks.filter((block) => block.type === 'text' && typeof block.text === 'string')
  const totalTextChars = textBlocks.reduce((total, block) => total + String(block.text).length, 0)
  if (totalTextChars <= maxTextChars) return null

  const combined = textBlocks.map((block) => String(block.text)).join('\n')
  const truncated = truncateToolResultText(combined, maxTextChars)
  const firstTextIndex = blocks.findIndex((block) => block.type === 'text')
  if (firstTextIndex < 0) return [...blocks, { type: 'text', text: truncated }]

  const before = blocks.slice(0, firstTextIndex).filter((block) => block.type !== 'text')
  const after = blocks.slice(firstTextIndex + 1).filter((block) => block.type !== 'text')
  return [...before, { type: 'text', text: truncated }, ...after]
}

/**
 * 把工具结果按所属的 assistant 回复分组。
 *
 * 一次 assistant 回复可以带多个 toolCall，它们的结果属于同一批推理依据。
 * 只按“最近 N 条”保留会把同批结果劈成一半完整一半截断，所以先按 toolCallId
 * 反查归属的 assistant 消息；查不到归属的结果按“与前一条连续”兜底归组。
 */
function groupToolResultIndices(messages: AgentMessage[]): number[][] {
  const ownerOfCall = new Map<string, number>()
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const content = (message as AssistantMessage).content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block && block.type === 'toolCall' && typeof block.id === 'string') ownerOfCall.set(block.id, index)
    }
  }

  const groups: number[][] = []
  let previousOwner: number | undefined
  let previousIndex: number | undefined
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message?.role !== 'toolResult') {
      previousOwner = undefined
      previousIndex = undefined
      continue
    }
    const owner = ownerOfCall.get((message as ToolResultMessage).toolCallId)
    const lastGroup = groups[groups.length - 1]
    const sameOwner = owner !== undefined && owner === previousOwner && lastGroup !== undefined
    const adjacentUnowned =
      owner === undefined && previousOwner === undefined && previousIndex === index - 1 && lastGroup !== undefined
    if (sameOwner || adjacentUnowned) lastGroup.push(index)
    else groups.push([index])
    previousOwner = owner
    previousIndex = index
  }
  return groups
}

function applyTextBudget(
  messages: AgentMessage[],
  options: PiContextBudgetOptions = {},
): { messages: AgentMessage[]; changed: boolean } {
  const groups = groupToolResultIndices(messages)
  if (groups.length === 0) return { messages, changed: false }

  let changed = false
  const next = [...messages]
  const loads = groups.map((group) => group.reduce((sum, index) => sum + toolResultTextLength(messages[index] as ToolResultMessage), 0))
  let total = 0
  // 按时间回放每组首次加入后的预算状态。后续请求/恢复会话会重放相同的整理边界，
  // 既不会因新增一组而滚动截断旧结果，也不会在已整理后把原文重新放回请求。
  let firstUntrimmedGroup = 0
  for (let end = 0; end < groups.length; end += 1) {
    total += loads[end] ?? 0
    if (total <= MAX_TOTAL_TOOL_RESULT_TEXT_CHARS) continue
    const firstRecentGroup = Math.max(0, end + 1 - KEEP_RECENT_TOOL_RESULT_GROUPS)
    while (firstUntrimmedGroup < firstRecentGroup && total > TARGET_TOOL_RESULT_TEXT_CHARS) {
      const groupIndex = firstUntrimmedGroup++
      let groupLoad = 0
      for (const index of groups[groupIndex] ?? []) {
        const original = messages[index] as ToolResultMessage
        const originalText = toolResultTextOf(original)
        const persisted = originalText && originalText.length > MAX_OLD_TOOL_RESULT_TEXT_CHARS
          && !originalText.startsWith(PERSISTED_TOOL_RESULT_PREFIX)
          ? persistToolResultText(originalText, original.toolCallId, options)
          : null
        if (persisted && originalText) {
          next[index] = withSingleTextBlock(original, buildPersistedPreview(originalText, persisted))
          changed = true
        } else {
          const budgeted = budgetToolResultText(original.content, MAX_OLD_TOOL_RESULT_TEXT_CHARS)
          if (budgeted !== null) {
            next[index] = { ...original, content: budgeted as ToolResultMessage['content'] } as AgentMessage
            changed = true
          }
        }
        groupLoad += toolResultTextLength(next[index] as ToolResultMessage)
      }
      total -= (loads[groupIndex] ?? 0) - groupLoad
      loads[groupIndex] = groupLoad
    }
  }
  return { messages: changed ? next : messages, changed }
}

/** 同步预算：文本截断 + 聚合落盘 + 图片张数裁剪。 */
export function budgetPiToolResults(
  messages: AgentMessage[],
  options: PiContextBudgetOptions = {},
): AgentMessage[] {
  const { messages: textBudgeted } = applyTextBudget(messages, options)
  const retained: ImageSlot[] = []
  const replacements: ImageReplacementMap = new Map()
  for (const slot of collectImageSlots(textBudgeted)) {
    if (textBudgeted[slot.messageIndex]?.role !== 'toolResult') continue
    retained.push(slot)
    if (retained.length <= MAX_CONTEXT_IMAGES) continue
    for (const dropped of retained.splice(0, retained.length - TARGET_CONTEXT_IMAGES)) {
      setImageReplacement(replacements, dropped.messageIndex, dropped.blockIndex, null)
    }
  }
  return applyImageReplacements(textBudgeted, replacements)
}

type ToolResultBlock = Record<string, unknown>
type ImageReplacementMap = Map<number, Map<number, ToolResultBlock | null>>

/**
 * 按原始 image block 对象缓存转码结果。
 *
 * prepareNextTurnWithContext 返回的是请求快照，不会改写 Pi 会话里的原始消息；
 * 同一张图每轮都会重新进入预算。WeakMap 以原始 block 为键，既避免每轮重复编码，
 * 又不会在会话结束后持有图片内存。
 */
const imageTranscodeCache = new WeakMap<object, Map<string, PiImageTranscodeResult | null>>()

function transcodeCacheKey(options: PiImageTranscodeOptions): string {
  return `${options.maxSide}:${options.quality}:${options.maxBase64Bytes}`
}

interface ImageSlot {
  messageIndex: number
  blockIndex: number
  block: ToolResultBlock
}

/** 原图是转码后体积的上界；回放中从未超字节预算时，只需处理张数整理后保留的图。 */
function planCountOnlyImageBudget(slots: ImageSlot[]): { retained: ImageSlot[]; replacements: ImageReplacementMap } | undefined {
  const retained: ImageSlot[] = []
  const replacements: ImageReplacementMap = new Map()
  let totalBase64 = 0
  for (const slot of slots) {
    retained.push(slot)
    totalBase64 += String(slot.block.data).length
    if (retained.length > MAX_CONTEXT_IMAGES) {
      for (const dropped of retained.splice(0, retained.length - TARGET_CONTEXT_IMAGES)) {
        totalBase64 -= String(dropped.block.data).length
        setImageReplacement(replacements, dropped.messageIndex, dropped.blockIndex, null)
      }
    }
    if (totalBase64 > MAX_CONTEXT_IMAGE_BASE64_BYTES) return undefined
  }
  return { retained, replacements }
}

function collectImageSlots(messages: AgentMessage[]): ImageSlot[] {
  const slots: ImageSlot[] = []
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]
    const role = (message as { role?: unknown } | undefined)?.role
    // 工具结果是主路径；user 消息也纳入，覆盖未来 session.prompt(images) 或桥接入口。
    if (!message || (role !== 'toolResult' && role !== 'user')) continue
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      const block = content[blockIndex]
      if (!block || typeof block !== 'object') continue
      const record = block as ToolResultBlock
      if (record.type === 'image' && typeof record.data === 'string' && record.data.length > 0) {
        slots.push({ messageIndex, blockIndex, block: record })
      }
    }
  }
  // 保持历史顺序；预算决策按图片首次出现的顺序回放，恢复后与连续请求一致。
  return slots
}

function setImageReplacement(
  replacements: ImageReplacementMap,
  messageIndex: number,
  blockIndex: number,
  replacement: ToolResultBlock | null,
): void {
  let blocks = replacements.get(messageIndex)
  if (!blocks) {
    blocks = new Map()
    replacements.set(messageIndex, blocks)
  }
  blocks.set(blockIndex, replacement)
}

async function transcodeImageSlot(
  slot: ImageSlot,
  options: PiImageTranscodeOptions,
  transcoder?: PiImageTranscoderPort,
): Promise<ToolResultBlock> {
  if (!transcoder) return slot.block
  const cacheKey = transcodeCacheKey(options)
  const cachedByTier = imageTranscodeCache.get(slot.block)
  if (cachedByTier?.has(cacheKey)) {
    const cached = cachedByTier.get(cacheKey)
    return cached
      ? { ...slot.block, data: cached.data, mimeType: cached.mimeType }
      : slot.block
  }

  const currentData = String(slot.block.data)
  const currentMimeType = typeof slot.block.mimeType === 'string' ? slot.block.mimeType : 'image/png'
  let result: PiImageTranscodeResult | null = null
  try {
    const transcoded = await transcoder.transcode({ data: currentData, mimeType: currentMimeType }, options)
    // 转码结果反而更大时缓存 null，下一轮直接保留原图，避免为了“压缩”把请求撑大。
    if (transcoded && typeof transcoded.data === 'string' && transcoded.data.length > 0 && transcoded.data.length < currentData.length) {
      result = {
        data: transcoded.data,
        mimeType: typeof transcoded.mimeType === 'string' ? transcoded.mimeType : 'image/jpeg',
      }
    }
  } catch {
    result = null
  }

  let cache = imageTranscodeCache.get(slot.block)
  if (!cache) {
    cache = new Map()
    imageTranscodeCache.set(slot.block, cache)
  }
  cache.set(cacheKey, result)

  return result ? { ...slot.block, data: result.data, mimeType: result.mimeType } : slot.block
}

function applyImageReplacements(messages: AgentMessage[], replacements: ImageReplacementMap): AgentMessage[] {
  if (replacements.size === 0) return messages

  let changed = false
  const next = [...messages]
  for (const [messageIndex, blockReplacements] of replacements) {
    const message = messages[messageIndex] as { content?: unknown } | undefined
    if (!message) continue
    const content = message.content
    if (!Array.isArray(content)) continue

    let omitted = 0
    const output: ToolResultBlock[] = []
    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      const block = content[blockIndex] as ToolResultBlock
      if (block && block.type === 'image' && blockReplacements.has(blockIndex)) {
        const replacement = blockReplacements.get(blockIndex)
        if (replacement) output.push(replacement)
        else omitted += 1
        continue
      }
      output.push(block)
    }
    if (omitted > 0) output.push({ type: 'text', text: `${OMITTED_TOOL_IMAGE_TEXT}（${omitted} 张）` })
    next[messageIndex] = { ...message, content: output } as unknown as AgentMessage
    changed = true
  }
  return changed ? next : messages
}

/**
 * 异步预算：文本与图片按历史顺序回放，仅在总量超限时成批整理。
 *
 * 图片首次发送用高清档；超出张数/字节预算后腾出一半空间，已有整理结果随历史
 * 确定性重建。预算内追加图片不再让已发送图片仅因变旧就重新编码。
 */
export async function budgetPiToolResultsWithImages(
  messages: AgentMessage[],
  transcoder?: PiImageTranscoderPort,
  options: PiContextBudgetOptions = {},
): Promise<AgentMessage[]> {
  const textBudget = applyTextBudget(messages, options)
  const textBudgeted = textBudget.messages
  const slots = collectImageSlots(textBudgeted)
  if (slots.length === 0) return textBudgeted

  const countOnly = planCountOnlyImageBudget(slots)
  if (countOnly) {
    for (const slot of countOnly.retained) {
      const block = await transcodeImageSlot(slot, HIGH_RES_IMAGE_OPTIONS, transcoder)
      if (block !== slot.block) setImageReplacement(countOnly.replacements, slot.messageIndex, slot.blockIndex, block)
    }
    return applyImageReplacements(textBudgeted, countOnly.replacements)
  }

  const replacements: ImageReplacementMap = new Map()
  const retained: Array<{ slot: ImageSlot; block: ToolResultBlock }> = []
  let totalBase64 = 0
  const dropOldest = (): void => {
    const dropped = retained.shift()
    if (!dropped) return
    totalBase64 -= String(dropped.block.data).length
    setImageReplacement(replacements, dropped.slot.messageIndex, dropped.slot.blockIndex, null)
  }
  for (const slot of slots) {
    const block = await transcodeImageSlot(slot, HIGH_RES_IMAGE_OPTIONS, transcoder)
    retained.push({ slot, block })
    totalBase64 += String(block.data).length
    if (block !== slot.block) setImageReplacement(replacements, slot.messageIndex, slot.blockIndex, block)

    if (retained.length > MAX_CONTEXT_IMAGES) {
      while (retained.length > TARGET_CONTEXT_IMAGES) dropOldest()
    }
    if (totalBase64 <= MAX_CONTEXT_IMAGE_BASE64_BYTES) continue

    // 只有总字节超限才降级旧图，最近两图继续保持清晰。
    for (let index = 0; index < retained.length - 2 && totalBase64 > TARGET_CONTEXT_IMAGE_BASE64_BYTES; index += 1) {
      const entry = retained[index]!
      const smaller = await transcodeImageSlot(entry.slot, OLD_IMAGE_OPTIONS, transcoder)
      if (String(smaller.data).length >= String(entry.block.data).length) continue
      totalBase64 -= String(entry.block.data).length - String(smaller.data).length
      entry.block = smaller
      setImageReplacement(replacements, entry.slot.messageIndex, entry.slot.blockIndex, smaller)
    }
    if (totalBase64 > MAX_CONTEXT_IMAGE_BASE64_BYTES) {
      while (retained.length > 1 && totalBase64 > TARGET_CONTEXT_IMAGE_BASE64_BYTES) dropOldest()
    }
    // 最新一张仍超限时再降一档，失败则保留原图，避免丢掉当前任务依据。
    if (totalBase64 > MAX_CONTEXT_IMAGE_BASE64_BYTES && retained.length === 1 && transcoder) {
      const entry = retained[0]!
      const emergency = await transcodeImageSlot(entry.slot, { maxSide: 800, quality: 60, maxBase64Bytes: 300_000 }, transcoder)
      if (String(emergency.data).length < String(entry.block.data).length) {
        totalBase64 = String(emergency.data).length
        entry.block = emergency
        setImageReplacement(replacements, entry.slot.messageIndex, entry.slot.blockIndex, emergency)
      }
    }
  }
  return applyImageReplacements(textBudgeted, replacements)
}

function isEmptyImageBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false
  const record = block as Record<string, unknown>
  if (record.type !== 'image') return false
  return typeof record.data !== 'string' || record.data.length === 0
}

function replaceEmptyImageBlocks(messages: AgentMessage[]): AgentMessage[] {
  let changed = false
  const next = messages.map((message) => {
    if (!message || typeof message !== 'object' || (message as { role?: unknown }).role !== 'toolResult') return message
    const toolResult = message as ToolResultMessage
    const content = toolResult.content as unknown
    if (!Array.isArray(content) || !content.some(isEmptyImageBlock)) return message
    changed = true
    return {
      ...toolResult,
      content: content.map((block) => (isEmptyImageBlock(block) ? { type: 'text', text: EMPTY_IMAGE_PLACEHOLDER_TEXT } : block)),
    } as unknown as AgentMessage
  })
  return changed ? next : messages
}

/**
 * 请求前历史消毒：工具若把空图像块（例如视图不可见时 capturePage 返回的空截图）写进会话历史，
 * 部分模型上游收到带空 data 的 image part 会挂起直到客户端超时（实测 kimi-k3 每次 ~105s 无响应
 * 后被自动重试，表现为“模型连不上”式死循环）。每轮构建请求前把空图像块替换为文本说明，
 * 既保护新写入的历史，也让已被污染的既有会话恢复可用。无空图时原样返回（不复制数组）。
 */
export function sanitizePiContextMessages(
  messages: AgentMessage[],
  options: PiContextBudgetOptions = {},
): AgentMessage[] {
  return budgetPiToolResults(replaceEmptyImageBlocks(messages), options)
}

/** 请求前历史消毒 + 图片分层压缩；Pi adapter 的实际入口。 */
export async function sanitizePiContextMessagesWithImages(
  messages: AgentMessage[],
  transcoder?: PiImageTranscoderPort,
  options: PiContextBudgetOptions = {},
): Promise<AgentMessage[]> {
  return budgetPiToolResultsWithImages(replaceEmptyImageBlocks(messages), transcoder, options)
}

/** transformContext 所需的最小 agent 面；便于单测不构造完整 Pi 会话。 */
export interface PiContextTransformAgent {
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>
}

/**
 * 把图片预算挂到 Pi 的 transformContext。
 *
 * 这是每次模型请求都会经过的入口（含恢复会话后的第一轮）；相比
 * prepareNextTurnWithContext 只覆盖 lastCompletedTurn 之后的轮次，它不会漏掉首轮。
 * 若 SDK/其他扩展已设置 transformContext，则先执行原逻辑再压缩。
 */
export function installPiContextBudget(
  agent: PiContextTransformAgent,
  transcoder?: PiImageTranscoderPort,
  options: PiContextBudgetOptions = {},
): void {
  const previousTransformContext = agent.transformContext
  agent.transformContext = async (messages, signal) => {
    const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages
    return sanitizePiContextMessagesWithImages(Array.isArray(transformed) ? transformed : messages, transcoder, options)
  }
}

function normalizeToolResultContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content
  return content.map((item) => {
    if (!item || typeof item !== 'object') return item
    const record = item as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') {
      return { type: 'text', text: record.text }
    }
    if (record.type === 'image') {
      return record
    }
    return record
  })
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block) {
        return typeof block.text === 'string' ? block.text : ''
      }
      return ''
    }).join('')
  }
  return ''
}

export function isAssistantPiMessage(message: AgentMessage): message is AssistantMessage {
  return !!message && typeof message === 'object' && 'role' in message && message.role === 'assistant'
}

export function isAbortedAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return isAssistantPiMessage(message) && message.stopReason === 'aborted'
}

export function dropTrailingAbortedAssistant(messages: AgentMessage[]): AgentMessage[] {
  const lastMessage = messages[messages.length - 1]
  return lastMessage && isAbortedAssistantMessage(lastMessage) ? messages.slice(0, -1) : messages
}

export const EMPTY_OUTPUT_ERROR_MESSAGE = '模型未生成可见回复'

/**
 * thinking-only 空输出里，思考内容至少要有这么多字才可能是一篇完整回答。
 * 低于这个长度的思考基本都是「想了两句就停了」，仍应走 empty_output 恢复。
 */
const MIN_PROMOTABLE_THINKING_CHARS = 120

function hasVisiblePiAssistantOutput(message: AssistantMessage): boolean {
  return message.content.some((block) => {
    if (block.type === 'text') return typeof block.text === 'string' && block.text.trim().length > 0
    return block.type === 'toolCall'
  })
}

function thinkingTextOf(message: AssistantMessage): string {
  return message.content
    .map((block) => (block.type === 'thinking' && typeof block.thinking === 'string' ? block.thinking : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

/**
 * 模型在 reasoning 里往往先写「准备怎么答」，再在「写。」这类提示后开始正文。
 * 下面三个正则分别定位：写作提示语、「篇幅/长度 N 字」这类自用要求、「不要以…结尾」这类指令行。
 */
const PLANNING_CUE = /(?:^|\n)[ \t]*(?:写|开始写|直接写|输出|汇报|答复|正文)[^\n]{0,8}[。：:][ \t]*/g
const PLANNING_LINE = /(?:^|\n)[ \t]*[^\n]{0,8}(?:篇幅|长度)[^\n]{0,24}?字[^\n]{0,12}?[。.][ \t]*/g
const PLANNING_INSTRUCTION = /(?:^|\n)[ \t]*不要(?:以|问|复述)[^\n]*/g
/** 收尾像完整回答的字符：句末标点、引号/反引号/括号。 */
const ANSWER_TAIL = /[。！？.!?）)」』”"'`~|]\s*$/
/** 正文首行至少像个句子（或 Markdown 结构），不能是「Go.」「写。」这种短指令。 */
const ANSWER_HEAD = /^(?:#{1,6}\s|[-*+]\s|\||>|\d+[.、]\s)/

function lastMatchEnd(pattern: RegExp, text: string): number {
  let end = -1
  for (const match of text.matchAll(pattern)) {
    end = Math.max(end, (match.index ?? 0) + match[0].length)
  }
  return end
}

/**
 * 只取「模型明确从筹划切换到书写」之后的内容。
 *
 * 实测泄漏的思考形如：先列汇报结构（“结构：1. 结论 2. 证据…篇幅 800 字左右”），
 * 再写「写。」或「写最终回复。」，后面才是真正给用户看的正文。
 *
 * 找不到这种边界就不提升：纯思考叙述（“Examining the file system…”、“Now let me
 * write the summary…Key points:”）不是答复，误当正文反而更差，宁交给 empty_output 重试。
 */
export function extractWrittenAnswer(text: string): string | null {
  const cut = Math.max(
    lastMatchEnd(PLANNING_CUE, text),
    lastMatchEnd(PLANNING_LINE, text),
    lastMatchEnd(PLANNING_INSTRUCTION, text),
  )
  if (cut <= 0) return null
  const tail = text.slice(cut).trim()
  if (tail.length < MIN_PROMOTABLE_THINKING_CHARS) return null
  if (!ANSWER_TAIL.test(tail)) return null
  const firstLine = tail.split('\n')[0]?.trim() ?? ''
  const startsLikeAnswer = firstLine.length >= 10 || ANSWER_HEAD.test(firstLine)
  return startsLikeAnswer ? tail : null
}

/**
 * 判断 thinking-only 空输出里的思考内容能否直接当正文。
 *
 * DeepSeek 系在长上下文里会把整篇回答写进 reasoning_content，再以 finish_reason=stop
 * 结束、content 为空。实测一个会话里 8 例全部是这种形态：思考里先写汇报提纲，
 * 再「写。」，然后就是完整正文。直接提升为正文，比「报错 + 原样重发 30 万 token」划算得多。
 * 截断在半句、或只是思考叙述的，仍交给 empty_output 恢复逻辑。
 */
export function promotableThinkingText(message: AssistantMessage): string | null {
  if (message.stopReason === 'aborted' || message.stopReason === 'error' || message.errorMessage) return null
  if (hasVisiblePiAssistantOutput(message)) return null
  const thinking = thinkingTextOf(message)
  if (thinking.length < MIN_PROMOTABLE_THINKING_CHARS) return null
  return extractWrittenAnswer(thinking)
}

function usageFromAssistant(message: AssistantMessage): {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
} {
  return {
    input_tokens: message.usage?.input ?? 0,
    output_tokens: message.usage?.output ?? 0,
    cache_read_input_tokens: message.usage?.cacheRead ?? 0,
    cache_creation_input_tokens: message.usage?.cacheWrite ?? 0,
  }
}

// 说明：本函数产出的消息 parent_tool_use_id 恒为 null。Pi 的事件模型（AgentEvent）不存在
// 子代理/sidechain 概念，AgentMessage 也无父子关联字段，故 pi 会话的所有消息都是主线。
// 旧 Claude SDK 持久化的会话可能带非空 parent_tool_use_id；宿主仍需兼容其父子消息关联。
export function convertPiMessage(
  message: AgentMessage,
  sessionId: string,
  channelModelId?: string,
  options: { final?: boolean; uuid?: string } = {},
): SDKMessage | null {
  const final = options.final ?? true
  if (!message || typeof message !== 'object' || !('role' in message)) return null

  if (message.role === 'user') {
    const user = message as UserMessage
    return {
      type: 'user',
      message: {
        content: [{ type: 'text', text: contentToText(user.content) }],
      },
      parent_tool_use_id: null,
      session_id: sessionId,
      ...(final && { uuid: options.uuid ?? randomUUID() }),
    } as unknown as SDKMessage
  }

  if (message.role === 'assistant') {
    const assistant = message as AssistantMessage
    // 只有 stopReason === 'error' 时才把 errorMessage 提升为终态 error 字段。
    // - 'aborted' 属于用户/系统主动中断，不是失败，弹「服务繁忙 + 重试」在语义上完全错误。
    // - 'stop' / 'length' / 'toolUse' 即使带 errorMessage 也只是 provider 中途抖动，
    //   Pi SDK 认定本轮已成功，不应在渲染层误导用户。
    // 上述非终态情况的 errorMessage 只写主进程 console，供开发排查；用户侧完全无感知。
    const isTerminalError = assistant.stopReason === 'error'
    // thinking-only 且思考内容已是完整答复时，提升为正文，不再当空输出处理。
    const promotedThinking = final ? promotableThinkingText(assistant) : null
    const isEmptyVisibleOutput = final
      && !promotedThinking
      && assistant.stopReason !== 'aborted'
      && !assistant.errorMessage
      && !hasVisiblePiAssistantOutput(assistant)
    if (assistant.errorMessage && !isTerminalError && final) {
      console.warn(
        `[pi-adapter] 忽略非终态 errorMessage（stopReason=${assistant.stopReason}）: ${assistant.errorMessage}`,
      )
    }
    return {
      type: 'assistant',
      message: {
        content: promotedThinking
          ? [{ type: 'text', text: promotedThinking }]
          : assistant.content.map((block) => {
            if (block.type === 'text') return { type: 'text', text: block.text }
            if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking }
            if (block.type === 'toolCall') {
              return {
                type: 'tool_use',
                id: block.id,
                name: displayToolName(block.name, block.arguments as Record<string, unknown>),
                // Pi 的 toolcall_delta 每帧携带累计 arguments。大 Write content 会随每个 token
                // 反复穿过 IPC、Jotai 和 React；预览帧只需保留工具身份，最终帧再提供完整 input。
                input: final ? normalizeToolUseInput(block.name, block.arguments as Record<string, unknown>) : {},
              }
            }
            return block as unknown as Record<string, unknown>
          }),
        usage: usageFromAssistant(assistant),
        model: assistant.model,
        stop_reason: assistant.stopReason,
      },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: options.uuid ?? randomUUID(),
      ...(!final && { _partial: true }),
      ...(assistant.errorMessage && isTerminalError && {
        error: { message: assistant.errorMessage, errorType: isTransientNetworkError(assistant.errorMessage) ? 'network_error' : 'provider_error' },
      }),
      ...(isEmptyVisibleOutput && {
        error: { message: EMPTY_OUTPUT_ERROR_MESSAGE, errorType: 'empty_output' },
        _emptyOutput: true,
      }),
      ...(promotedThinking && { _promotedFromThinking: true }),
      ...(channelModelId && { _channelModelId: channelModelId }),
    } as unknown as SDKMessage
  }

  if (message.role === 'toolResult') {
    const toolResult = message as ToolResultMessage
    return {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: toolResult.toolCallId,
          content: normalizeToolResultContent(toolResult.content),
          is_error: toolResult.isError,
        }],
      },
      tool_use_result: toolResult.details,
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: randomUUID(),
    } as unknown as SDKMessage
  }

  return null
}

/**
 * 检测 Pi 终态错误消息是否同时携带有效正文内容（#1268 断流保消息）。
 *
 * 当 Pi 流式输出中途断连时，stopReason='error' 且同时存在
 * errorMessage 和已有部分正文；此时应先将正文作为正常消息展示，
 * 再追加简短错误摘要，而不应把整个正文渲染在红色错误卡片内。
 */
export function hasTerminalErrorWithContent(msg: SDKMessage): boolean {
  if (msg.type !== 'assistant') return false
  const assistant = msg as SDKAssistantMessage
  if (!assistant.error) return false
  const content = assistant.message?.content
  if (!Array.isArray(content) || content.length === 0) return false
  const text = content
    .filter((block) => block.type === 'text' && typeof (block as { text?: string }).text === 'string')
    .map((block) => (block as { text: string }).text)
    .join('\n')
    .trim()
  if (!text) return false

  // Pi/OpenAI 上游有时会把同一句错误文案同时放入 content 与 errorMessage。
  // 这不是「断流前已生成的正文」；若误判为正文，编排层会在自动重试尚未结束时
  // 提前渲染红色错误卡，并与 Agent Running 指示器同时存在。
  return text !== assistant.error.message?.trim()
}

/**
 * 从带错误的 SDKMessage 中剥离出纯正文消息（#1268 断流保消息）。
 *
 * 返回 contentMessage（不含 error 字段、保留原 uuid 以覆盖流式部分帧）
 * 和 errorText（用于生成简短错误摘要）。若消息不含正文内容则返回 null。
 */
export function stripErrorFromContentMessage(msg: SDKMessage): { contentMessage: SDKMessage; errorText: string } | null {
  if (!hasTerminalErrorWithContent(msg)) return null
  const assistant = msg as SDKAssistantMessage
  const errorText = assistant.error?.message ?? '流式传输中断'
  // 浅拷贝 message.content 并移除 error 字段，保留 uuid 覆盖流式部分帧
  const contentMessage: SDKMessage = {
    ...msg,
    error: undefined,
    message: {
      ...assistant.message,
      content: assistant.message.content,
    },
  } as unknown as SDKMessage
  // 确保 error 字段被彻底删除（展开运算符可能保留 undefined）
  delete (contentMessage as Record<string, unknown>).error
  return { contentMessage, errorText }
}

export function hasToolResult(message: SDKMessage): boolean {
  if (message.type !== 'user') return false
  const content = (message as { message?: { content?: Array<{ type?: string }> } }).message?.content
  return Array.isArray(content) && content.some((block) => block.type === 'tool_result')
}

export function convertResultMessage(
  messages: AgentMessage[],
  sessionId: string,
  override?: RuntimeGuardResultOverride,
  contextWindow?: number,
  modelId?: string,
  channelModelId?: string,
): SDKMessage {
  const assistants = messages.filter((m): m is AssistantMessage =>
    !!m && typeof m === 'object' && 'role' in m && m.role === 'assistant')
  const costValues = assistants
    .map((msg) => msg.usage?.cost?.total)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  const usage = assistants.reduce(
    (acc, msg) => ({
      input_tokens: acc.input_tokens + (msg.usage?.input ?? 0),
      output_tokens: acc.output_tokens + (msg.usage?.output ?? 0),
      cache_read_input_tokens: acc.cache_read_input_tokens + (msg.usage?.cacheRead ?? 0),
      cache_creation_input_tokens: acc.cache_creation_input_tokens + (msg.usage?.cacheWrite ?? 0),
    }),
    { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  )
  const lastAssistant = assistants[assistants.length - 1]
  const assistantError = lastAssistant?.errorMessage
  // 思考内容已提升为正文时，本轮不算空输出。
  const promotedThinking = lastAssistant ? promotableThinkingText(lastAssistant) : null
  const isEmptyVisibleOutput = Boolean(
    lastAssistant
    && !promotedThinking
    && lastAssistant.stopReason !== 'aborted'
    && !hasVisiblePiAssistantOutput(lastAssistant)
    && !assistantError,
  )
  const terminalReason = override?.terminalReason ?? (
    isEmptyVisibleOutput
      ? 'empty_output'
      : lastAssistant?.stopReason === 'length'
        ? 'max_tokens'
        : 'completed'
  )
  return {
    type: 'result',
    subtype: override?.subtype ?? (isEmptyVisibleOutput ? 'error_during_execution' : assistantError ? 'error_during_execution' : terminalReason === 'max_tokens' ? 'max_tokens' : 'success'),
    usage,
    total_cost_usd: costValues.length > 0 ? costValues.reduce((sum, cost) => sum + cost, 0) : undefined,
    ...(contextWindow != null && { modelUsage: { [modelId ?? channelModelId ?? 'default']: { contextWindow } } }),
    ...((channelModelId ?? modelId) && { _channelModelId: channelModelId ?? modelId }),
    terminal_reason: terminalReason,
    errors: override?.errors ?? (isEmptyVisibleOutput ? [EMPTY_OUTPUT_ERROR_MESSAGE] : assistantError ? [assistantError] : undefined),
    session_id: sessionId,
  } as unknown as SDKMessage
}
