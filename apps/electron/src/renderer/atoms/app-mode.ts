/**
 * App Mode Atom — 应用模式状态
 *
 * - chat: 对话模式
 * - agent: Agent 模式（原 Flow）
 * - scratch: 草稿本模式
 *
 * ## 为什么分成两层（v2）
 *
 * 模式有两条互相竞争的真相来源：
 *  1. 用户意图：点了 Agent / Chat、按了 ⌘⇧M、新建会话……
 *  2. 当前激活的标签页：chat / agent / tutorial / scratch / plugin……
 *
 * 旧实现只有一层可变 `appModeAtom`，靠十多个「打开标签页」的调用点各自记得顺手
 * 同步一次。任何一条路径漏了，就会出现「模式切换器高亮 Agent，激活的标签却是
 * Chat 会话」——`⌘⇧M`（toggle-mode）就是最典型的一条：它只改模式、不动标签页。
 *
 * 现在拆成：
 *  - `appModeIntentAtom`：用户意图，可写、持久化；
 *  - `appModeAtom`：**派生自当前激活标签页**，标签页能表达模式时以它为准，
 *    否则回落到意图。
 *
 * 这样「显示的模式」与「正在看的标签页」不可能再对不上，也不需要每个调用点
 * 记得同步。写入 `appModeAtom` 等同写入意图（兼容既有的 `setAppMode(...)` 调用）。
 */

import { atom } from 'jotai'
import { atomWithStorage, createJSONStorage } from 'jotai/utils'
import { SCRATCH_PAD_ID, activeTabAtom, type TabItem } from './tab-atoms'

export type AppMode = 'chat' | 'agent' | 'scratch'

/** 用户意图模式，按窗口持久化到 sessionStorage（刷新后保持上次选择）。 */
export const appModeIntentAtom = atomWithStorage<AppMode>('profer-app-mode', 'agent', createJSONStorage<AppMode>(() => globalThis.sessionStorage))

/**
 * 从标签页推导模式。
 *
 * 返回 `null` 表示「这个标签页不代表任何模式」，此时应沿用用户意图：
 *  - `null`（没有标签页）：保留意图，避免启动瞬间闪烁
 *  - `tutorial` / `frp-guide` / `plugin`：文档与插件页与模式无关
 *  - `scratch`：草稿本是独立空间，仍由意图表达
 */
export function appModeForTab(tab: TabItem | null): AppMode | null {
  if (!tab) return null
  if (tab.type === 'chat') return 'chat'
  if (tab.type === 'agent' || tab.type === 'preview' || tab.type === 'browser') return 'agent'
  if (tab.id === SCRATCH_PAD_ID) return 'scratch'
  return null
}

/**
 * 当前生效的应用模式。
 *
 * 标签页能表达模式时以标签页为准（「屏幕上正在看什么」是唯一真相），
 * 否则回落到用户意图。写入等同于写意图。
 */
export const appModeAtom = atom<AppMode, [AppMode], void>(
  (get) => appModeForTab(get(activeTabAtom)) ?? get(appModeIntentAtom),
  (_get, set, next: AppMode) => {
    set(appModeIntentAtom, next)
  },
)
