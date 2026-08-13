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
 * 只有当用户再次点浏览器按钮（openBrowser 清除标记）或首次触发时才自动打开。
 */
export const browserPanelDismissedSessionIdsAtom = atom<Set<string>>(new Set<string>())

/** 用户手动恢复文件面板后，该会话再次打开浏览器时不再自动收起。 */
export const browserFilePanelManualRestoreSessionIdsAtom = atomWithStorage<string[]>(
  'profer-browser-file-panel-manual-restore-session-ids',
  [],
)

/**
 * 用户在当前会话手动打开浏览器的标记集合。
 * 与文件面板的 userOverrodeAutoHide 对齐：窄屏自动收起后，用户手动点开浏览器，
 * 本次不再被 MainArea 的 788 阈值自动收起；窗口/布局恢复到阈值以上时重置。
 * 仅存于内存，不持久化——会话/窗口变化即失效，避免残留旧会话脏标记。
 */
export const browserManualOpenSessionIdsAtom = atom<Set<string>>(new Set<string>())

export const currentSessionBrowserStateAtom = atom<BrowserViewState | null>((get) => {
  const sessionId = get(currentAgentSessionIdAtom)
  return sessionId ? get(browserStateMapAtom).get(sessionId) ?? null : null
})
