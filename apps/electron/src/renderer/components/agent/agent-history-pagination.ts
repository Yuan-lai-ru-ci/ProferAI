import type { RewindTarget, SDKMessage } from '@profer/shared'

/** 使用已提交的回退锚点，避免用后端 UUID 计数裁剪包含无 UUID 记录的分页。 */
export function clipAgentHistoryAfterRewind(messages: SDKMessage[], target: RewindTarget): SDKMessage[] {
  if (target.kind !== 'message') return []
  const end = messages.findIndex(message => 'uuid' in message && message.uuid === target.messageUuid)
  return messages.slice(0, end + 1)
}

export interface AgentHistoryPageLike {
  messages: SDKMessage[]
  startIndex?: number
  hasMore?: boolean
}

export interface AgentHistoryCursorState {
  startIndex: number
  hasMore: boolean
}

export interface AgentHistoryLoadResult {
  messages: SDKMessage[]
  cursor: AgentHistoryCursorState
  isPage: boolean
}

export interface AgentHistoryRefreshNormalization {
  messages: SDKMessage[]
  cursor: AgentHistoryCursorState
  isPage: boolean
  /** 为保持原窗口起点而裁掉的前缀条数 */
  clippedCount: number
}

/** 兼容分页对象与旧版纯数组返回值。旧数组由调用方的 hasMore 状态函数决定是否继续。 */
export function normalizeAgentHistoryResult(
  value: unknown,
  previous: AgentHistoryCursorState,
  legacyHasMore?: boolean,
): AgentHistoryLoadResult {
  const isPage = !Array.isArray(value) && value !== null && typeof value === 'object' && 'messages' in value
  if (!isPage) {
    return {
      messages: Array.isArray(value) ? value as SDKMessage[] : [],
      cursor: {
        startIndex: Math.max(0, previous.startIndex - (Array.isArray(value) ? value.length : 0)),
        hasMore: typeof legacyHasMore === 'boolean' ? legacyHasMore : previous.hasMore,
      },
      isPage: false,
    }
  }

  const page = value as AgentHistoryPageLike
  const messages = Array.isArray(page.messages) ? page.messages : []
  const startIndex = typeof page.startIndex === 'number'
    ? page.startIndex
    : Math.max(0, previous.startIndex - messages.length)
  return {
    messages,
    cursor: {
      startIndex,
      // Older page objects may omit hasMore; a positive cursor still proves there is history.
      hasMore: page.hasMore === true || startIndex > 0,
    },
    isPage: true,
  }
}

/**
 * refresh（流结束 / 终止 / 出错 / rewind）后的窗口归一化。
 *
 * 触发 refresh 的 tail = 「已加载条数」+ 余量，而「已加载条数」本身已经包含上一次
 * refresh 顺带拉回的更早历史 —— 直接采用会让窗口每刷新一次向前膨胀一个余量
 * （用户凭空看到更早的若干轮对话），且随刷新次数线性累积、会话越长越明显。
 *
 * 这里裁掉超出原起点的前缀：窗口起点保持不动，只追加本轮新消息；同时把游标推进到
 * 实际显示的起点，保证后续「加载更早消息」不会重复拉取已经显示的区间。
 *
 * 越界保护：rewind 会把会话文件截断变小，原起点可能落在返回页之外。此时整页保留
 * （窗口重置），绝不裁剪，否则会把消息区裁空。
 *
 * @param page 归一化后的分页结果
 * @param previousStartIndex 本次 refresh 之前已加载窗口的起点；会话切换时为 null
 *   （此时窗口基准来自内存缓存，不存在跨 refresh 的累计膨胀）
 */
export function normalizeAgentHistoryRefresh(
  page: AgentHistoryLoadResult,
  previousStartIndex: number | null,
): AgentHistoryRefreshNormalization {
  const { messages, cursor } = page
  // 兼容旧版 preload 的纯数组返回：其推算出的 startIndex 会得到 overflow === 整页长度，
  // 交由下方边界守卫拦下；这里显式短路以表明意图。
  if (!page.isPage || previousStartIndex === null) {
    return { messages, cursor, isPage: page.isPage, clippedCount: 0 }
  }
  const overflow = previousStartIndex - cursor.startIndex
  // overflow <= 0：窗口没有前移，无需裁剪。
  // overflow >= messages.length：返回页整体早于原窗口（文件被截断 / 窗口重置），保留整页。
  if (overflow <= 0 || overflow >= messages.length) {
    return { messages, cursor, isPage: true, clippedCount: 0 }
  }
  const startIndex = cursor.startIndex + overflow
  return {
    messages: messages.slice(overflow),
    cursor: { startIndex, hasMore: startIndex > 0 },
    isPage: true,
    clippedCount: overflow,
  }
}
