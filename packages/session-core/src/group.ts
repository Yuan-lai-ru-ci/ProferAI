/**
 * Turn 分组 — 将流式产生的 SDKMessage 列表(含同一回合的多行快照碎片)
 * 合并为可渲染/可导出的 Turn 分组。
 *
 * 这是 Profer 会话「快照去重」的唯一真源：Electron 渲染层、profer CLI 以及
 * 未来的 query 型接口都复用本模块，避免各处重抄一份会随存储格式漂移的解析器。
 *
 * 逻辑逐字迁移自 apps/electron 渲染层 SDKMessageRenderer.tsx，保持行为一致。
 */
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKSystemMessage,
} from '@profer/shared'
import { isGoalIterationMessage } from '@profer/shared'
import { normalizeThinkTagsInContentBlocks } from './thinking-tags'

// ===== 辅助：从 SDKMessage 提取元数据 =====

export interface MessageMeta {
  createdAt?: number
}

export function extractMeta(message: SDKMessage): MessageMeta {
  const msg = message as Record<string, unknown>
  return {
    createdAt: typeof msg._createdAt === 'number' ? msg._createdAt : undefined,
  }
}

// ===== 辅助：从 user 消息中提取纯文本内容 =====

export function extractUserText(message: SDKUserMessage): string | null {
  const content = message.message?.content
  if (!Array.isArray(content)) return null

  const texts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && 'text' in block) {
      texts.push((block as { text: string }).text)
    }
  }

  return texts.length > 0 ? texts.join('\n') : null
}

// ===== 辅助：判断 user 消息是否为真正的人类用户输入（非工具结果/子代理提示） =====

export function isUserInputMessage(message: SDKUserMessage): boolean {
  if (message.parent_tool_use_id) return false
  // SDK 合成消息（如 Skill 展开 prompt）不是用户输入
  if (message.isSynthetic) return false
  // Goal 迭代注入的控制 prompt 不是用户对话内容（以分隔条形式独立展示）
  if (isGoalIterationMessage(message)) return false
  // 包含 tool_result 块的消息是工具结果，不是用户输入
  const content = message.message?.content
  if (Array.isArray(content) && content.some((b) => b.type === 'tool_result')) return false
  return extractUserText(message) !== null
}

// ===== Turn 分组类型 =====

export interface AssistantTurn {
  type: 'assistant-turn'
  /** 当前 turn 内所有 assistant 消息 */
  assistantMessages: SDKAssistantMessage[]
  /** 当前 turn 内所有消息（含 tool_result user 消息，供工具结果查找） */
  turnMessages: SDKMessage[]
  /** 模型名称（取首条 assistant 消息的 model） */
  model?: string
  /** 创建时间（取首条 assistant 消息的时间） */
  createdAt?: number
  /**
   * 该 turn 由后台任务完成通知（task_notification）唤醒后开始。
   * 用于阻断与前一 turn 的合并，让自动唤醒的新输出独立成块，而不是被追加进上一轮的消息块。
   */
  startsAfterWake?: boolean
}

export type MessageGroup =
  | { type: 'user'; message: SDKUserMessage }
  | { type: 'system'; message: SDKSystemMessage }
  | AssistantTurn

/**
 * 中断/断组语义分层（导航索引与渲染层一致，见下）。
 *
 * 渲染层为了把「已被用户中断」这类提示渲染成独立分隔条，把 interruption_record /
 * skill_routing_notice 也当作断组边界；而本模块的历史默认口径（回溯水位、CLI outline）
 * 保持 compact_boundary / compacting / permission_denied 的历史口径；task_trigger
 * 在两端都必须独立成组，保留新 Run 的来源边界。
 *
 * 两者都是既成事实，不能互相覆盖：回溯水位用本模块默认口径（countTurns 合同已写明
 * 必须与主进程 retrospective-service 一致），导航计数用渲染口径。
 */
const NAVIGATION_BREAKING_SUBTYPES: ReadonlySet<string> = new Set([
  'compact_boundary',
  'compacting',
  'permission_denied',
  'interruption_record',
  'skill_routing_notice',
  'compact_skipped',
  'task_trigger',
])

/** 历史默认断组集合（回溯水位 / CLI outline 沿用）。 */
const DEFAULT_BREAKING_SUBTYPES: ReadonlySet<string> = new Set([
  'compact_boundary',
  'compacting',
  'permission_denied',
  'task_trigger',
])

/**
 * 将 SDKMessage 列表分组为可渲染的 Turn
 *
 * 规则：
 * 1. user（真正用户输入）→ 单独的 user group
 * 2. assistant + user(tool_result) + assistant... → 合并为一个 assistant-turn
 * 3. system（task_trigger / compact_boundary / compacting / permission_denied）→ 独立渲染，其他归入当前 turn
 * 4. 其他类型（result, tool_progress 等）→ 归入当前 assistant-turn
 * 5. 后处理：合并相邻同模型的 assistant-turn（处理子代理切换模型导致的碎片化）
 *
 * @param options.breakingSubtypes 覆盖 system 消息的断组集合。渲染层/导航索引需要含
 *   interruption_record 与 skill_routing_notice 的子集口径；省略时保持历史默认行为。
 */
export function groupIntoTurns(
  messages: SDKMessage[],
  sessionModelId?: string,
  options?: { breakingSubtypes?: ReadonlySet<string> },
): MessageGroup[] {
  const breakingSubtypes = options?.breakingSubtypes ?? DEFAULT_BREAKING_SUBTYPES
  const groups: MessageGroup[] = []
  let currentTurn: AssistantTurn | null = null
  // 收到后台任务完成通知（task_notification）后，若没有用户输入就直接出现新的 assistant 输出，
  // 说明这是自动唤醒的新一轮，应另起独立消息块，而不是续接上一轮。
  // 注意：不能用 result 做信号——正常对话每轮也以 result 结束，会误伤普通回复。
  let pendingWakeBoundary = false

  const flushTurn = (): void => {
    if (currentTurn && currentTurn.assistantMessages.length > 0) {
      groups.push(currentTurn)
    }
    currentTurn = null
  }

  for (const msg of messages) {
    if (msg.type === 'user') {
      const userMsg = msg as SDKUserMessage
      if (isGoalIterationMessage(userMsg)) {
        // Goal 迭代控制消息 → 独立段落（分隔条），作为 turn 边界但不进入 turn 消息
        flushTurn()
        groups.push({ type: 'user', message: userMsg })
        pendingWakeBoundary = false
      } else if (isUserInputMessage(userMsg)) {
        // 真正的用户输入 → 结束当前 turn，开始新段落
        flushTurn()
        groups.push({ type: 'user', message: userMsg })
        pendingWakeBoundary = false
      } else {
        // tool_result 消息 → 归入当前 turn
        if (currentTurn) {
          currentTurn.turnMessages.push(msg)
        }
      }
    } else if (msg.type === 'assistant') {
      const aMsg = msg as SDKAssistantMessage
      // 跳过重放消息
      if (aMsg.isReplay) continue

      if (!currentTurn) {
        // 开始新 turn
        const meta = extractMeta(msg)
        currentTurn = {
          type: 'assistant-turn',
          assistantMessages: [aMsg],
          turnMessages: [msg],
          model: aMsg._channelModelId || aMsg.message?.model || sessionModelId,
          createdAt: meta.createdAt,
          // 紧跟在后台任务唤醒之后的新 turn：阻断与上一轮的合并
          startsAfterWake: pendingWakeBoundary || undefined,
        }
        pendingWakeBoundary = false
      } else {
        // 继续当前 turn
        currentTurn.assistantMessages.push(aMsg)
        currentTurn.turnMessages.push(msg)
      }
    } else if (msg.type === 'system') {
      const sysMsg = msg as SDKSystemMessage
      // 仅需要独立渲染的 system 消息才中断 turn；其他 system 消息（如 init、task_started、
      // task_progress）归入当前 turn，不中断分组。集合按 breakingSubtypes 决定（见函数头）。
      if (sysMsg.subtype === 'task_trigger' || (sysMsg.subtype && breakingSubtypes.has(sysMsg.subtype))) {
        flushTurn()
        groups.push({ type: 'system', message: sysMsg })
      } else if (sysMsg.subtype === 'task_notification') {
        // 后台任务完成通知：仅在没有进行中的 turn 时标记唤醒边界（真正的唤醒场景）。
        // 若当前有 turn 正在进行，归入当前 turn 不截断。
        if (currentTurn) {
          currentTurn.turnMessages.push(msg)
        } else {
          pendingWakeBoundary = true
        }
      } else if (currentTurn) {
        currentTurn.turnMessages.push(msg)
      }
    } else {
      // result, tool_progress 等 → 归入当前 turn
      // prompt_suggestion 不属于对话转录，不入 turn，避免被当作文本附加到助手消息末尾
      if ((msg as { type: string }).type === 'prompt_suggestion') {
        continue
      }
      if (currentTurn) {
        currentTurn.turnMessages.push(msg)
      }
    }
  }

  flushTurn()
  return mergeAdjacentSameModelTurns(groups)
}

/**
 * 统计「可分析轮次」数量 —— 即 user 输入组 + assistant-turn 组之和（不含 system 组）。
 *
 * 这是回溯放弃抽取的「水位」计数口径：主进程 retrospective-service 的 renderTurns
 * 每个 user/assistant-turn 组产出一条编号轮次，其总数恒等于本函数返回值；渲染层用它
 * 计算「本次新增 N 轮」时必须走同一口径，否则触发判断与 lastAnalyzedTurn 水位会错位。
 * 两侧都不要传 sessionModelId（合并行为需一致）。
 */
export function countTurns(messages: SDKMessage[]): number {
  let n = 0
  for (const g of groupIntoTurns(messages)) {
    if (g.type === 'user' || g.type === 'assistant-turn') n++
  }
  return n
}

/**
 * 导航索引条目 —— 「消息导航」里的一行。
 *
 * 身份分两级：
 * - `id`：渲染层 data-message-id 的取值（消息 uuid / assistant 轮首条 uuid）。有 uuid 时
 *   可直接当滚动锚点用；磁盘上确实无 uuid 的分组（interruption_record、部分旧格式输入）为 null。
 * - `matchKey`：无 uuid 时的稳定回退键（role + subtype + 创建时间），供渲染层在本已
 *   加载的 DOM 里找回对应节点，而不是点不动。
 */
export interface NavigationEntry {
  /** 滚动锚点 id（消息 uuid）；无 uuid 时为 null，需用 matchKey 回退 */
  id: string | null
  role: 'user' | 'assistant' | 'status'
  /** 单行预览（<=200 字） */
  preview: string
  /** assistant 回合的模型 id（用于取模型图标） */
  model?: string
  /** 无 uuid 时的稳定匹配键：`${role}:${subtype}:${createdAt}` */
  matchKey: string
}

/** 分组内的身份字段（uuid / subtype / createdAt），供锚点 id 与 matchKey 共用。 */
function navigationIdentity(group: MessageGroup): {
  uuid: string | null
  subtype: string
  createdAt: string
} {
  const anchor = group.type === 'assistant-turn'
    ? (group.assistantMessages[0] as unknown as Record<string, unknown> | undefined)
    : (group.message as unknown as Record<string, unknown>)
  const uuid = typeof anchor?.uuid === 'string' && anchor.uuid.length > 0 ? anchor.uuid : null
  const subtype = typeof anchor?.subtype === 'string' ? anchor.subtype : ''
  const createdAt = typeof anchor?._createdAt === 'number' ? String(anchor._createdAt) : ''
  return { uuid, subtype, createdAt }
}

/**
 * 系统消息在「消息导航」里的预览文案。
 *
 * 渲染层 MessageGroupRenderer 只渲染这几种 subtype（其余返回 null），且中断/技能/压缩提示另有
 * 文案。本模块的 getGroupPreview 是 CLI/回溯共用的历史口径，不能为了导航去改它（会扰动
 * 已有消费者），所以导航侧在这里单独镜像渲染层的分支。
 */
function navigationSystemPreview(sysMsg: SDKSystemMessage): string | null {
  switch (sysMsg.subtype) {
    case 'task_trigger': return (sysMsg.message ?? '任务来源').slice(0, 200)
    case 'compact_boundary': return '上下文已压缩'
    case 'permission_denied': return '自动审批已拒绝操作'
    // `compacting` 只驱动实时状态，渲染层返回 null（不占行）。
    case 'compacting': return null
    case 'interruption_record': return sysMsg.message ?? '任务中断'
    case 'skill_routing_notice': return sysMsg.message ?? 'Skill 未加载'
    case 'compact_skipped': return sysMsg.message ?? '上下文压缩已跳过'
    default: return null
  }
}

/**
 * 构建会话导航索引：一轮一行，覆盖传入的全部消息。
 *
 * 与渲染层「迷你地图」保持同一断组口径（含 interruption_record / skill_routing_notice）
 * 与同一行集（仅渲染层真正渲染的 system subtype 占行），因此主进程与渲染层算出的行列、
 * 顺序与文案一致。
 */
export function buildNavigationEntries(
  messages: SDKMessage[],
  sessionModelId?: string,
): NavigationEntry[] {
  const groups = groupIntoTurns(messages, sessionModelId, { breakingSubtypes: NAVIGATION_BREAKING_SUBTYPES })
  const entries: NavigationEntry[] = []
  for (const group of groups) {
    const role: NavigationEntry['role'] = group.type === 'user' ? 'user' : group.type === 'system' ? 'status' : 'assistant'
    let preview: string
    if (group.type === 'system') {
      const systemPreview = navigationSystemPreview(group.message)
      // null = 渲染层不占行（compacting / 未知 subtype）。
      if (systemPreview === null) continue
      preview = systemPreview
    } else {
      preview = getGroupPreview(group)
    }
    const { uuid, subtype, createdAt } = navigationIdentity(group)
    entries.push({
      id: uuid,
      role,
      preview,
      model: group.type === 'assistant-turn' ? group.model : undefined,
      matchKey: `${role}:${subtype}:${createdAt}`,
    })
  }
  return entries
}

/**
 * 后处理：合并相邻同模型的 assistant-turn
 *
 * 当子代理（如 haiku）执行多个工具调用时，中间的 user(tool_result) 消息
 * 可能导致 turn 被拆分为多个碎片。此函数将同模型的相邻 assistant-turn 合并，
 * 同时吸收它们之间的非用户输入 group（如被误判为用户输入的子代理内部消息）。
 */
function mergeAdjacentSameModelTurns(groups: MessageGroup[]): MessageGroup[] {
  if (groups.length <= 1) return groups

  const result: MessageGroup[] = []

  for (const group of groups) {
    if (group.type !== 'assistant-turn') {
      result.push(group)
      continue
    }

    // 后台任务唤醒后开始的 turn：独立成块，不向前合并。
    if (group.startsAfterWake) {
      result.push(group)
      continue
    }

    // 向前查找可合并的同模型 assistant-turn（跳过非 user-input 的中间 group）
    let mergeTargetIdx = -1
    for (let i = result.length - 1; i >= 0; i--) {
      const prev = result[i]!
      if (prev.type === 'user') break // 真正的用户输入阻断合并
      if (prev.type === 'system' && ['task_trigger', 'compact_boundary', 'permission_denied'].includes((prev.message as SDKSystemMessage).subtype ?? '')) break
      if (prev.type === 'assistant-turn') {
        if (prev.model === group.model) {
          mergeTargetIdx = i
        }
        break // 遇到第一个 assistant-turn 就停止（不跨越不同模型的 turn）
      }
      // system 或其他 group：继续向前查找
    }

    if (mergeTargetIdx >= 0) {
      const target = result[mergeTargetIdx] as AssistantTurn
      target.assistantMessages.push(...group.assistantMessages)
      target.turnMessages.push(...group.turnMessages)
    } else {
      result.push(group)
    }
  }

  return result
}

// ===== 预览/摘要 =====

const SCHEDULED_RUN_MARKER = '<!--PROFER_SCHEDULED_RUN-->'
/** 旧版（改名前的 proma）定时标记：历史消息里持久化的是它，必须继续剥离。 */
const LEGACY_SCHEDULED_RUN_MARKER = '<!--PROMA_SCHEDULED_RUN-->'

export function stripScheduledRunMarker(text: string): string {
  return text.replaceAll(SCHEDULED_RUN_MARKER, '').replaceAll(LEGACY_SCHEDULED_RUN_MARKER, '').trim()
}

/**
 * 用户消息正文里混着若干「不是用户说的话」的上下文块：
 * 附件清单、引用文件、引用消息/可视化/中断说明、被引用的会话清单。
 *
 * 预览/大纲只该显示用户真正敲的字，否则迷你地图里会冒出整段 XML
 * （典型现场：`<quoted_context source="agent-interruption" ...`）。
 */
const USER_CONTEXT_BLOCK_PATTERNS = [
  /<attached_files>[\s\S]*?<\/attached_files>\n*/g,
  /<quoted_file[^>]*>[\s\S]*?<\/quoted_file>\n*/g,
  /<quoted_context[^>]*>[\s\S]*?<\/quoted_context>\n*/g,
  /<referenced_sessions>[\s\S]*?<\/referenced_sessions>\n*/g,
] as const

export function stripUserContextBlocks(text: string): string {
  let result = text
  for (const pattern of USER_CONTEXT_BLOCK_PATTERNS) result = result.replace(pattern, '')
  return result.trim()
}

/**
 * 从 MessageGroup 中提取纯文本预览，供迷你地图 / outline 使用
 */
export function getGroupPreview(group: MessageGroup): string {
  if (group.type === 'user') {
    if (isGoalIterationMessage(group.message)) {
      const iteration = (group.message as unknown as Record<string, unknown>)._goalIteration
      return typeof iteration === 'number' ? `Goal 自动迭代 · 第 ${iteration} 轮` : 'Goal 自动迭代'
    }
    return stripUserContextBlocks(stripScheduledRunMarker(extractUserText(group.message) ?? ''))
      .slice(0, 200)
  }
  if (group.type === 'system') {
    if (group.message.subtype === 'task_trigger') return (group.message.message ?? '任务来源').slice(0, 200)
    if (group.message.subtype === 'compact_boundary') return '上下文已压缩'
    if (group.message.subtype === 'compacting') return '正在压缩上下文...'
    if (group.message.subtype === 'permission_denied') return '自动审批已拒绝操作'
    return ''
  }
  // assistant-turn：收集所有 text 块
  const texts: string[] = []
  for (const aMsg of group.assistantMessages) {
    const rawBlocks = aMsg.message?.content
    if (!Array.isArray(rawBlocks)) continue
    for (const block of normalizeThinkTagsInContentBlocks(rawBlocks)) {
      if (block.type === 'text' && 'text' in block) {
        texts.push((block as { text: string }).text)
      }
    }
  }
  return texts.join(' ').slice(0, 200)
}
