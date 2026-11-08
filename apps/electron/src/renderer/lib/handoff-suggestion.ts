/**
 * session-handoff-suggestion — 判断「是否该建议用户新开会话」的纯函数
 *
 * 为什么需要两个触发源：
 * 轮数是用户能理解、能配置的刻度，但「一轮」的成本差异极大——一轮可能只是
 * 一句追问，也可能是读完二十个文件。只按轮数判断，轻对话会被过早打断、
 * 重工具调用则等到轮数达标时上下文早就该压缩了。所以除了用户设的阈值，
 * 再挂一个上下文占用触发（与 ContextUsageBadge 的告警线一致）：
 * 它只能**提前**提醒，不能突破「功能已关闭」或「用户已忽略」的闸门。
 *
 * 所有闸门优先于触发源：流式进行中、用户已忽略、交接正在进行时一律不显示。
 * 纯函数、无 React/Jotai 依赖，便于单测锁住这些边界。
 */

/** 上下文占用达到该比例即认为「继续聊下去会触发压缩」，与 ContextUsageBadge 的告警线一致。 */
export const HANDOFF_CONTEXT_PRESSURE_RATIO = 0.8

export type HandoffSuggestionReason = 'turnThreshold' | 'contextPressure'

export interface HandoffSuggestionInput {
  /** 本会话的用户提问轮数 */
  turnCount: number
  /** 设置里的轮数阈值；<= 0 表示功能关闭 */
  threshold: number
  /** 上下文窗口占用比例 0..1；未就绪时传 0 */
  contextRatio: number
  /** 当前会话是否正在流式输出 */
  streaming: boolean
  /** 用户是否已对本会话点过「不再提示」 */
  dismissed: boolean
  /** 本会话是否已有交接在进行 */
  inFlight: boolean
}

export type HandoffSuggestion =
  | { visible: false; reason: null }
  | { visible: true; reason: HandoffSuggestionReason }

const HIDDEN: HandoffSuggestion = { visible: false, reason: null }

export function resolveHandoffSuggestion(input: HandoffSuggestionInput): HandoffSuggestion {
  const { turnCount, threshold, contextRatio, streaming, dismissed, inFlight } = input

  // 关闭态优先于一切：用户把阈值设成 0 就是不想看到这条建议，
  // 上下文再满也不该冒出来（那时该由上下文徽标自己提示压缩）。
  if (!Number.isFinite(threshold) || threshold <= 0) return HIDDEN

  // 一轮没跑完就劝人换会话，用户会在错误的时机点下去（交接要等当前轮结束）。
  if (streaming) return HIDDEN
  if (dismissed) return HIDDEN
  if (inFlight) return HIDDEN

  if (turnCount >= threshold) return { visible: true, reason: 'turnThreshold' }

  // 上下文压力只能提前一倍：否则「第 2 轮读了个大文件」也会被劝去新开会话，
  // 而那时候交接文档里几乎没东西可交。
  const earliestByContext = Math.max(1, Math.ceil(threshold / 2))
  if (contextRatio >= HANDOFF_CONTEXT_PRESSURE_RATIO && turnCount >= earliestByContext) {
    return { visible: true, reason: 'contextPressure' }
  }

  return HIDDEN
}
