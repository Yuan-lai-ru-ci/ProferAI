import { atom } from 'jotai'
import type { AppWindowSummary, MainWindowBootstrap } from '@profer/shared'

const windowBootstrapStateAtom = atom<MainWindowBootstrap | null>(null)
export const appWindowsAtom = atom<AppWindowSummary[]>([])

/** 角色由主进程实时快照决定；接任不改窗口身份，也不重放 initialTab/草稿。 */
export const windowBootstrapAtom = atom(
  (get) => {
    const bootstrap = get(windowBootstrapStateAtom)
    if (!bootstrap) return null
    const own = get(appWindowsAtom).find(window => window.windowId === bootstrap.windowId)
    if (!own || own.isPrimary === bootstrap.isPrimary) return bootstrap
    return { ...bootstrap, isPrimary: own.isPrimary, kind: own.isPrimary ? 'main' as const : bootstrap.kind }
  },
  (_get, set, bootstrap: MainWindowBootstrap | null) => set(windowBootstrapStateAtom, bootstrap),
)
export const windowSessionKeysAtom = atom((get) => new Set(get(appWindowsAtom)
  .filter(window => !window.isPrimary)
  .flatMap(window => window.sessions.map(session => `${session.type}:${session.sessionId}`))))
