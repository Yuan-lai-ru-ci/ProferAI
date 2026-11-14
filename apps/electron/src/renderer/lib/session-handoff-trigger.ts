/**
 * 手动触发「会话交接」的可用态判定（纯函数）
 *
 * 与 `resolveHandoffSuggestion` 的区别是本质性的：建议条是**系统劝用户换会话**，
 * 所以它要看设置阈值、上下文占用、用户是否点过「不再提示」；工具栏按钮是
 * **用户主动点**，意图本身就是触发条件，上面那些闸门一个都不该挡。
 * 尤其 `handoffSuggestTurnCount` 默认 0（建议功能关闭），手动按钮必须照常可用。
 *
 * 只保留三类「点了必然出错/没意义」的技术闸门：
 * 1. 已有交接在飞：连点会建出多个会话、多次跑文档撰写；
 * 2. 本会话正在跑：文档撰写是往**同一份 JSONL** 追加的一次 headless run，
 *    与本轮运行同时写会撞车，且读到的是半截转录；
 * 3. 消息还没加载完 / 会话是空的：没有可交接的内容。
 *
 * 纯函数、无 React/Jotai 依赖，闸门边界由单测锁住。
 */

export type ManualHandoffBlockReason = 'inFlight' | 'running' | 'loading' | 'empty'

export interface ManualHandoffInput {
  /** 本会话是否已完成首次消息加载 */
  sessionReady: boolean
  /** 会话里是否已有可交接的消息（持久化或实时） */
  hasContent: boolean
  /** 本会话是否正在运行：流式 / 后台等待 / 压缩 / 换内核统一折算 */
  running: boolean
  /** 本会话是否已有一次交接在进行 */
  inFlight: boolean
}

export type ManualHandoffState =
  | { enabled: true; hint: null; reason: null }
  | { enabled: false; hint: string; reason: ManualHandoffBlockReason }

/**
 * 空闲时的 hover 只报按钮名：代价说明（模型调用 / 建会话 / 切标签）由确认弹窗承担，
 * 这里再重复一遍只是噪音。禁用态不走这个常量，用 `hint` 显示「为什么不能点」。
 */
export const MANUAL_HANDOFF_TOOLTIP = '交接并新开会话'

export function resolveManualHandoffState(input: ManualHandoffInput): ManualHandoffState {
  // 在飞优先于 running：交接本身就是一次 run，别把它显示成「等本轮结束」。
  if (input.inFlight) {
    return { enabled: false, reason: 'inFlight', hint: '正在撰写交接文档，完成后会自动切到新会话…' }
  }
  if (input.running) {
    return { enabled: false, reason: 'running', hint: '等本轮运行结束再交接（交接文档要读完整的会话记录）' }
  }
  if (!input.sessionReady) {
    return { enabled: false, reason: 'loading', hint: '会话内容加载中…' }
  }
  if (!input.hasContent) {
    return { enabled: false, reason: 'empty', hint: '会话还没有内容，无需交接' }
  }
  return { enabled: true, hint: null, reason: null }
}
