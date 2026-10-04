/** 原 SDK block → 归一化段 → 过程/回复分组；纯派生层不持有折叠或窗口状态。 */
import type {
  SDKAssistantMessage,
  SDKContentBlock,
  SDKMessage,
  SDKToolResultBlock,
  SDKToolUseBlock,
  SDKUserMessage,
} from '@profer/shared'
import { isGoalUpdateToolName } from '@profer/shared'
import { normalizeThinkTagsInContentBlocks } from './thinking-tag-parser'

export interface StableContentBlock extends IndexedContentBlock {
  identity: string
}

interface EnrichedBlock extends StableContentBlock {
  parentToolUseId?: string | null
}

interface DeriveAssistantTurnBlocksOptions {
  isStreaming?: boolean
  /** 无 UUID/stableKey 的旧消息由调用方提供对象引用身份，不依赖数组位置。 */
  getMessageIdentity: (message: SDKAssistantMessage) => string
}

export interface DerivedAssistantTurnBlocks {
  enrichedBlocks: EnrichedBlock[]
  topLevelItems: StableContentBlock[]
  topLevelBlocks: SDKContentBlock[]
  childBlocksMap: Map<string, SDKContentBlock[]>
  hasError: boolean
  errorContent: SDKAssistantMessage | null
}

export function deriveAssistantTurnBlocks(
  messages: SDKAssistantMessage[],
  options: DeriveAssistantTurnBlocksOptions,
): DerivedAssistantTurnBlocks {
  const enrichedBlocks: EnrichedBlock[] = []
  let hasError = false
  let errorContent: SDKAssistantMessage | null = null

  for (const message of messages) {
    if (message.error) {
      hasError = true
      errorContent = message
      continue
    }
    const blocks = message.message?.content
    if (!Array.isArray(blocks)) continue
    const stableKey = (message as unknown as { _promaStableKey?: unknown })._promaStableKey
    const messageIdentity = message.uuid
      || (typeof stableKey === 'string' ? stableKey : options.getMessageIdentity(message))
    for (const [rawIndex, rawBlock] of blocks.entries()) {
      const toolId = rawBlock.type === 'tool_use' && typeof rawBlock.id === 'string' ? rawBlock.id : undefined
      const source = toolId ? `tool:${encodeURIComponent(toolId)}` : `block:${rawIndex}`
      const occurrences = new Map<string, number>()
      for (const block of normalizeThinkTagsInContentBlocks([rawBlock], {
        // 终态漏闭合标签仍保留既有正文兜底；流式阶段等待闭标签。
        unclosedTagAsText: !options.isStreaming,
      })) {
        const occurrence = occurrences.get(block.type) ?? 0
        occurrences.set(block.type, occurrence + 1)
        enrichedBlocks.push({
          block,
          index: enrichedBlocks.length,
          identity: `${encodeURIComponent(messageIdentity)}:${source}:${encodeURIComponent(block.type)}:${occurrence}`,
          parentToolUseId: message.parent_tool_use_id,
        })
      }
    }
  }

  const agentToolIds = new Set<string>()
  for (const { block } of enrichedBlocks) {
    if (block.type === 'tool_use') {
      const tool = block as SDKToolUseBlock
      if (tool.name === 'Agent' || tool.name === 'Task') agentToolIds.add(tool.id)
    }
  }
  const childBlocksMap = new Map<string, SDKContentBlock[]>()
  const topLevelItems: StableContentBlock[] = []
  for (const item of enrichedBlocks) {
    if (item.parentToolUseId && agentToolIds.has(item.parentToolUseId)) {
      const children = childBlocksMap.get(item.parentToolUseId) ?? []
      children.push(item.block)
      childBlocksMap.set(item.parentToolUseId, children)
    } else {
      topLevelItems.push({ block: item.block, index: topLevelItems.length, identity: item.identity })
    }
  }
  return {
    enrichedBlocks, topLevelItems,
    topLevelBlocks: topLevelItems.map((item) => item.block),
    childBlocksMap, hasError, errorContent,
  }
}

export interface IndexedContentBlock {
  block: SDKContentBlock
  /** 归一化位置只用于任务映射/展示顺序，不作为渲染身份。 */
  index: number
  /** 由原 SDK 消息与原 block 派生；旧的纯分组调用可以不传。 */
  identity?: string
}

export type AssistantTurnRenderItem<T extends IndexedContentBlock = IndexedContentBlock> =
  | { type: 'block'; item: T }
  | { type: 'visualization'; record: import('@profer/shared').VisualizationRecord; identity: string }
  | { type: 'process-group'; items: T[] }

interface BuildAssistantTurnRenderItemsOptions {
  isStreaming?: boolean
  completedToolResultIds?: Set<string>
  /**
   * 上层是否展示 thinking 块；显式 false 时把 thinking 从可见块里剔除。
   * 缺省 true 保持旧行为（不传的调用方不受影响）。
   */
  showThinking?: boolean
}

export function buildCompletedToolResultIds(turnMessages: SDKMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const msg of turnMessages) {
    if (msg.type !== 'user') continue
    const userMsg = msg as SDKUserMessage
    const blocks = userMsg.message?.content
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      if (b.type !== 'tool_result') continue
      const rb = b as SDKToolResultBlock
      ids.add(rb.tool_use_id)
    }
  }
  return ids
}

interface TrailingOutputSplit {
  /** 最终正文（最后一段连续 text）在原数组中的起始下标 */
  textStartIndex: number
  /** 最终正文结束下标（含） */
  textEndIndex: number
}

/**
 * 定位「最终正文」区间：数组里最后一段连续的 text 块。
 *
 * 旧实现要求数组最后一个块必须是 text，否则整轮（含最终回复）会被整体折叠进「执行过程」。
 * 但真实流式数据里存在 text 之后又追加 thinking 的形态：
 *  - 同一条 assistant 消息里 reasoning 晚于正文到达（`[text, thinking]`）；
 *  - 正文之后紧跟一条只含 thinking 的收尾消息（turn 内聚合后同样以 thinking 结尾）。
 * 这两种情况下正文才是应当直接可见的交付内容，必须外置；末尾 thinking 归入过程组。
 * 若正文之后还跟着 tool_use 等块，说明这段 text 更可能是给工具看的中间说明，保持整组折叠。
 *
 * 注意：部分内核+模型组合下 thinking 块不渲染（Pi 内核上只回摘要的 GPT/Codex 系，
 * 见 shouldShowAgentThinking）。一旦正文被一起折叠，用户会看到整轮只剩「执行过程：N 条消息」
 * 一行、正文彻底看不见。
 */
function getTrailingOutputSplit(blocks: SDKContentBlock[]): TrailingOutputSplit | null {
  let textEndIndex = -1
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (blocks[index]?.type === 'text') {
      textEndIndex = index
      break
    }
  }
  if (textEndIndex < 0) return null

  for (let index = textEndIndex + 1; index < blocks.length; index++) {
    if (blocks[index]?.type !== 'thinking') return null
  }

  let textStartIndex = textEndIndex
  while (textStartIndex > 0 && blocks[textStartIndex - 1]?.type === 'text') {
    textStartIndex -= 1
  }
  return { textStartIndex, textEndIndex }
}

function areToolsBeforeIndexCompleted(
  blocks: SDKContentBlock[],
  endIndex: number,
  completedToolResultIds: Set<string> | undefined,
): boolean {
  if (!completedToolResultIds) return false

  // 末尾 text 前的所有 tool_use 索引（用于区分「单工具」与「多工具收尾」场景）
  const toolIndices: number[] = []
  for (let index = 0; index < endIndex; index++) {
    const block = blocks[index]
    if (block?.type !== 'tool_use') continue
    toolIndices.push(index)
  }
  if (toolIndices.length === 0) {
    // 没有 tool_use 时不认为"工具已完成"——避免流式中只有 thinking + 尾部 text
    // 时把还可能变成中间过程的 text 提前外置。
    return false
  }

  // 多工具长序列：允许「最后一个工具的 result 还在路上」时也把尾部 text 外置——
  // 此时 text 几乎可以确定是最终回复（Agent 已开始收尾输出），
  // 不应因最后一个工具结果晚到而把整段回复折叠进执行过程。
  // 单工具场景保持保守：仅一个 tool_use 且结果未到，text 仍可能是给工具看的中间说明。
  for (let i = 0; i < toolIndices.length; i++) {
    const isLastTool = i === toolIndices.length - 1
    if (toolIndices.length > 1 && isLastTool) continue
    const toolBlock = blocks[toolIndices[i]!] as SDKToolUseBlock
    if (!completedToolResultIds.has(toolBlock.id)) return false
  }

  return true
}

export function buildAssistantTurnRenderItems(
  blocks: StableContentBlock[],
  options?: BuildAssistantTurnRenderItemsOptions,
): AssistantTurnRenderItem<StableContentBlock>[]
export function buildAssistantTurnRenderItems(
  blocks: SDKContentBlock[],
  options?: BuildAssistantTurnRenderItemsOptions,
): AssistantTurnRenderItem[]
export function buildAssistantTurnRenderItems(
  blocks: SDKContentBlock[] | StableContentBlock[],
  options: BuildAssistantTurnRenderItemsOptions = {},
): AssistantTurnRenderItem[] {
  const visibleBlocks = blocks
    .map((entry, index): IndexedContentBlock => {
      // 新渲染链直接传派生 item，分组保持同一对象与身份；兼容既有纯 block 调用。
      if ('block' in entry && 'identity' in entry && 'index' in entry) return entry as StableContentBlock
      return { block: entry as SDKContentBlock, index }
    })
    .filter(({ block }) => {
      if (block.type === 'tool_use' && isGoalUpdateToolName((block as SDKToolUseBlock).name)) return false
      // 上层已判定不展示思考（Pi 内核上只回摘要的 GPT/Codex 系）时，必须在派生阶段就剔除 thinking：
      // 否则过程组会把它算进「执行过程：N 条消息」，展开后却什么都渲染不出来。
      if (block.type === 'thinking' && options.showThinking === false) return false
      return true
    })
  if (visibleBlocks.length === 0) return []
  const renderBlocks = visibleBlocks.map(({ block }) => block)

  // 流式阶段最后的 text 还不稳定，后续工具调用可能会把它变成中间过程。
  // 只有当前面所有工具都有结果时，才把尾部 text 视作最终输出，降低完成瞬间的跳动。
  const hasProcessBlock = renderBlocks.some((block) => block.type === 'tool_use' || block.type === 'thinking')
  const outputSplit = getTrailingOutputSplit(renderBlocks)
  const canSplitStreamingFinalOutput = options.isStreaming
    && hasProcessBlock
    && outputSplit !== null
    && outputSplit.textStartIndex > 0
    && areToolsBeforeIndexCompleted(renderBlocks, outputSplit.textStartIndex, options.completedToolResultIds)

  if (options.isStreaming && hasProcessBlock && !canSplitStreamingFinalOutput) {
    return [{ type: 'process-group', items: visibleBlocks }]
  }

  if (outputSplit === null) {
    return [{ type: 'process-group', items: visibleBlocks }]
  }

  const { textStartIndex, textEndIndex } = outputSplit
  // 正文之前的步骤 + 正文之后仅剩的 thinking（收尾思考）统一归入过程组。
  const processItems: IndexedContentBlock[] = []
  for (let index = 0; index < textStartIndex; index++) {
    const item = visibleBlocks[index]
    if (item) processItems.push(item)
  }
  for (let index = textEndIndex + 1; index < visibleBlocks.length; index++) {
    const item = visibleBlocks[index]
    if (item) processItems.push(item)
  }

  const items: AssistantTurnRenderItem[] = []
  if (processItems.length > 0) items.push({ type: 'process-group', items: processItems })
  for (let index = textStartIndex; index <= textEndIndex; index++) {
    const item = visibleBlocks[index]
    if (item) items.push({ type: 'block', item })
  }
  return items
}
