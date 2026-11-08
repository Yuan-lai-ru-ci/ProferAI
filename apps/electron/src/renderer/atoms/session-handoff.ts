/**
 * 会话交接（建议新开会话）的渲染层状态
 *
 * 三块互不相关但都要给建议条用的状态：
 * 1. `handoffSuggestTurnCountAtom` — 用户在设置里配的轮数阈值，0 = 关闭；
 * 2. `agentSessionTurnCountAtom` — 每个会话的「用户提问轮数」，由消息列表的
 *    全会话导航索引发布（那是唯一不需要分页就能拿到全量轮次的地方）；
 * 3. `handoffDismissedAtom` — 用户点过「不再提示」的会话，纯内存态。
 *
 * 与 `atoms/session-preview-settings.ts` 保持同一套写法：
 * 朴素 atom + 初始化函数 + 「先写本地、落盘失败回滚」的更新函数。
 * 不新增设置 IPC：复用既有的 `settings:get` / `settings:update`。
 */

import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import {
  DEFAULT_HANDOFF_SUGGEST_TURN_COUNT,
  MAX_HANDOFF_SUGGEST_TURN_COUNT,
  type AppSettings,
} from '@/types/settings'

/** 建议新开会话的轮数阈值（0 = 关闭） */
export const handoffSuggestTurnCountAtom = atom<number>(DEFAULT_HANDOFF_SUGGEST_TURN_COUNT)

/** 每个会话的用户提问轮数；缺省视为 0（消息列表还没发布） */
export const agentSessionTurnCountAtom = atom<Map<string, number>>(new Map())

const EMPTY_TURN_COUNT = 0

/** 按 sessionId 切片的轮数，避免任意会话更新都唤醒当前建议条。 */
export const agentSessionTurnCountFamily = atomFamily((sessionId: string) =>
  atom((get) => get(agentSessionTurnCountAtom).get(sessionId) ?? EMPTY_TURN_COUNT),
)

/**
 * 已被用户忽略的会话集合。
 *
 * 纯内存、不落盘：重启后再提醒一次是合理的——用户当时的「不再提示」
 * 针对的是那一次上下文，不是永久策略（永久关掉应该去设置里把阈值改成 0）。
 */
export const handoffDismissedAtom = atom<Set<string>>(new Set<string>())

/** 从主进程读取阈值；失败保持默认（关闭），不改变既有行为。 */
export async function initializeHandoffSuggestTurnCount(
  setCount: (count: number) => void,
): Promise<void> {
  try {
    const settings = await window.electronAPI.getSettings()
    setCount(settings.handoffSuggestTurnCount ?? DEFAULT_HANDOFF_SUGGEST_TURN_COUNT)
  } catch (error) {
    console.error('[会话交接] 初始化轮数阈值失败:', error)
  }
}

/** 更新阈值并持久化：先写本地 atom（立即生效），落盘失败回滚到上一个值 */
export async function updateHandoffSuggestTurnCount(
  count: number,
  setCount: (count: number) => void,
  previous: number = DEFAULT_HANDOFF_SUGGEST_TURN_COUNT,
): Promise<void> {
  setCount(count)
  try {
    await window.electronAPI.updateSettings({ handoffSuggestTurnCount: count })
  } catch (error) {
    console.error('[会话交接] 更新轮数阈值失败:', error)
    setCount(previous)
    throw error
  }
}

/**
 * 从设置对象里解出阈值。
 *
 * 单独抽出来是为了让「设置页读盘」与「启动水合」用同一套归一逻辑，
 * 避免设置页显示一个数、建议条按另一个数判断。
 */
export function resolveHandoffSuggestTurnCount(settings: Partial<AppSettings>): number {
  const raw = settings.handoffSuggestTurnCount
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_HANDOFF_SUGGEST_TURN_COUNT
  return Math.min(Math.round(raw), MAX_HANDOFF_SUGGEST_TURN_COUNT)
}
