import { atom } from 'jotai'
import type { BrowserViewState } from '@profer/shared'

/** 每个 Agent 会话的浏览器状态镜像。主进程仍是状态权威（BROWSER_STATE_CHANGED 推送）。 */
export const browserStateMapAtom = atom<Map<string, BrowserViewState>>(new Map())
