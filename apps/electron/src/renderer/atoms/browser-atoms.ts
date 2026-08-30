import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { BrowserViewState } from '@profer/shared'
import { currentAgentSessionIdAtom } from './agent-atoms'

/** 每个 Agent 会话的受管浏览器面板开关。主进程仍是状态权威。 */
export const browserPanelOpenMapAtom = atom<Map<string, boolean>>(new Map())
export const browserStateMapAtom = atom<Map<string, BrowserViewState>>(new Map())

/** 浏览器作为独立同级卡片时的会话区宽度比例。与文件预览分栏独立保存。 */
export const browserSplitRatioAtom = atomWithStorage<number>('profer-browser-split-ratio', 0.58)

/**
 * 用户已手动关闭浏览器面板的会话 ID 集合。
 * 主进程 BROWSER_STATE_CHANGED 推送不应强制重开用户刚关掉的面板；
 * 切换回仍保留浏览器状态的会话时自动恢复，用户再次点浏览器按钮（openBrowser 清除标记）也可恢复。
 */
export const browserPanelDismissedSessionIdsAtom = atom<Set<string>>(new Set<string>())

export const currentSessionBrowserStateAtom = atom<BrowserViewState | null>((get) => {
  const sessionId = get(currentAgentSessionIdAtom)
  return sessionId ? get(browserStateMapAtom).get(sessionId) ?? null : null
})
