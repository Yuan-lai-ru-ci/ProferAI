import { expect, mock, test } from 'bun:test'

mock.module('./browser-risk-disclaimer', () => ({
  hasAcknowledgedBrowserRiskDisclaimer: () => true,
}))

import { BrowserController } from './browser-controller'

function harness(label = 'button「打开菜单」', options: { delayedFeedback?: boolean } = {}) {
  const commands: string[] = []
  const observedTexts: string[] = []
  let snapshotReads = 0
  let fallbackDispatched = false
  const debuggerClient = {
    isAttached: () => true,
    attach: () => undefined,
    detach: () => undefined,
    sendCommand: async (method: string) => {
      commands.push(method)
      if (method === 'DOM.resolveNode' && options.delayedFeedback) return { object: { objectId: 'node-1' } }
      if (method === 'Runtime.callFunctionOn' && options.delayedFeedback) return { result: { value: true } }
      if (method === 'Input.dispatchMouseEvent') {
        fallbackDispatched = true
        return {}
      }
      if (method === 'Runtime.evaluate' && options.delayedFeedback) {
        snapshotReads += 1
        const text = fallbackDispatched ? '菜单已打开' : '菜单'
        observedTexts.push(text)
        return { result: { value: { url: 'https://example.com/', title: '示例页', text } } }
      }
      if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
      return {}
    },
  }
  const tab = {
    tabId: 'tab-1',
    generation: 1,
    frameCount: 0,
    frameIds: new Set<string>(),
    pendingNetworkRequestIds: new Set<string>(),
    commandTail: Promise.resolve(),
    refs: new Map([['r1-1', { backendNodeId: 7, generation: 1, label, editable: false }]]),
    state: {
      tabId: 'tab-1', url: 'https://example.com/', title: '示例页', localFile: null,
      loading: false, visible: true, canGoBack: false, canGoForward: false,
      zoomFactor: 1, translated: false, loadError: null, trace: [],
    },
    lastActivityAt: 0,
    view: {
      webContents: { debugger: debuggerClient, isDestroyed: () => false },
      setVisible: () => undefined,
    },
  }
  const browserSession = {
    sessionId: 'session-1', tabs: new Map([[tab.tabId, tab]]), activeTabId: tab.tabId,
    agentTabId: tab.tabId, agentAbortController: new AbortController(), allowedRoots: [],
    executionSource: 'automation' as const, ledger: [], userOpenedAt: null,
    invalidatedLayoutRendererInstanceIds: new Set<string>(), lastLayoutRendererInstanceId: null,
    lastLayoutSourceRevision: 0, lastLayoutRevision: 0, hostView: {}, lastVisible: true,
  }
  const controller = new BrowserController()
  const internals = controller as unknown as { sessions: Map<string, typeof browserSession> }
  internals.sessions.set(browserSession.sessionId, browserSession)
  return { controller, browserSession, commands, observedTexts }
}

test('低风险菜单点击：合成点击没有即时反馈，单次 fallback 后页面变化即 verified', async () => {
  const { controller, commands, observedTexts } = harness('button「打开菜单」', { delayedFeedback: true })

  const result = await controller.click('session-1', 'r1-1')

  expect(result.trace.at(-1)).toMatchObject({ action: 'click', status: 'verified', success: true })
  expect(observedTexts).toEqual(['菜单', '菜单', '菜单', '菜单已打开', '菜单已打开'])
  expect(commands.filter((method) => method === 'Input.dispatchMouseEvent')).toHaveLength(2)
  expect(commands.filter((method) => method === 'Runtime.callFunctionOn')).toHaveLength(1)
})
test('低风险 click 无可观测变化时只允许一次 CDP fallback，之后结果为 unknown', async () => {
  const { controller, browserSession, commands } = harness()

  const first = await controller.click('session-1', 'r1-1')
  expect(first.trace.at(-1)).toMatchObject({ action: 'click', status: 'unknown', success: false })
  expect(commands.filter((method) => method === 'Input.dispatchMouseEvent')).toHaveLength(2)

  await expect(controller.click('session-1', 'r1-1')).rejects.toThrow('请先重新调用 BrowserObserve')
  expect(commands.filter((method) => method === 'Input.dispatchMouseEvent')).toHaveLength(2)
  expect(browserSession.ledger.at(-1)).toMatchObject({ action: 'click', status: 'unknown' })
})

test('高风险 click 无法确认时不执行 CDP fallback', async () => {
  const { controller, commands } = harness('button「提交订单」')

  const result = await controller.click('session-1', 'r1-1')
  expect(result.trace.at(-1)).toMatchObject({ action: 'click', status: 'failed', success: false })
  expect(commands.filter((method) => method === 'Input.dispatchMouseEvent')).toHaveLength(0)
})

test('不同 session 的同名 ref 不共享 click 防重复状态', async () => {
  const first = harness()
  const second = harness()
  const secondInternals = second.controller as unknown as { sessions: Map<string, typeof second.browserSession> }
  secondInternals.sessions.clear()
  secondInternals.sessions.set('session-2', { ...second.browserSession, sessionId: 'session-2' })

  await first.controller.click('session-1', 'r1-1')
  await second.controller.click('session-2', 'r1-1')
  expect(first.commands.filter((method) => method === 'Input.dispatchMouseEvent')).toHaveLength(2)
  expect(second.commands.filter((method) => method === 'Input.dispatchMouseEvent')).toHaveLength(2)
})
