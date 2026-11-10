import { atom } from 'jotai'
import type { BrowserViewState } from '@profer/shared'

/** 每个 Agent 会话的浏览器状态镜像。主进程仍是状态权威（BROWSER_STATE_CHANGED 推送）。 */
export const browserStateMapAtom = atom<Map<string, BrowserViewState>>(new Map())

/**
 * 用户已手动关闭浏览器 Tab 的会话 ID 集合。
 * 主进程 BROWSER_STATE_CHANGED 推送不应强制重开用户刚关掉的 Tab；
 * 用户再次点浏览器入口（手动打开会清除标记）也可恢复。
 */
export const browserPanelDismissedSessionIdsAtom = atom<Set<string>>(new Set<string>())
