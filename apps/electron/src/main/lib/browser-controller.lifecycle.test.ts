import { expect, test } from 'bun:test'
import { BrowserController } from './browser-controller'

test('关闭最后一个标签时移除原生 hostView，避免透明区域继续拦截全局点击', async () => {
  const calls = {
    hostVisible: [] as boolean[],
    hostBounds: [] as Array<{ x: number; y: number; width: number; height: number }>,
    removedChildren: [] as unknown[],
    removedHosts: [] as unknown[],
    tabClosed: 0,
  }
  const hostView = {
    setVisible: (visible: boolean) => calls.hostVisible.push(visible),
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) => calls.hostBounds.push(bounds),
    removeChildView: (view: unknown) => calls.removedChildren.push(view),
  }
  const webContents = {
    debugger: { isAttached: () => false, detach: () => undefined },
    isDestroyed: () => false,
    close: () => { calls.tabClosed += 1 },
  }
  const tab = {
    tabId: 'tab-1',
    view: { webContents, setVisible: () => undefined },
    state: { visible: true },
  }
  const browserSession = {
    sessionId: 'session-1',
    tabs: new Map([[tab.tabId, tab]]),
    activeTabId: tab.tabId,
    agentTabId: tab.tabId,
    hostView,
    lastVisible: true,
  }
  const owner = {
    isDestroyed: () => false,
    contentView: { removeChildView: (view: unknown) => calls.removedHosts.push(view) },
  }
  const controller = new BrowserController()
  const internals = controller as unknown as {
    owner: typeof owner
    foregroundSessionId: string | null
    sessions: Map<string, typeof browserSession>
  }
  internals.owner = owner
  internals.foregroundSessionId = browserSession.sessionId
  internals.sessions.set(browserSession.sessionId, browserSession)

  expect(await controller.closeTab(browserSession.sessionId, tab.tabId)).toBeNull()
  expect(controller.getState(browserSession.sessionId)).toBeNull()
  // 浏览器 session 已销毁，但当前前台 Agent 会话所有权必须保留；否则同会话重新打开后
  // 新的 native layout 会被主进程误判为后台，表现为空白无画面。
  expect(internals.foregroundSessionId).toBe(browserSession.sessionId)
  expect(calls.hostVisible).toEqual([false])
  expect(calls.hostBounds).toEqual([{ x: 0, y: 0, width: 0, height: 0 }])
  expect(calls.removedChildren).toEqual([tab.view])
  expect(calls.removedHosts).toEqual([hostView])
  expect(calls.tabClosed).toBe(1)
})
