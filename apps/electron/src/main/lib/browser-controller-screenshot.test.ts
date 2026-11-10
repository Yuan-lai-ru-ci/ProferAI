import { expect, mock, test } from 'bun:test'

mock.module('./browser-risk-disclaimer', () => ({
  hasAcknowledgedBrowserRiskDisclaimer: () => true,
}))

import { BrowserController } from './browser-controller'

/**
 * 回归：视图隐藏/未渲染时 capturePage 会「成功」返回空 NativeImage。
 * 空截图若作为成功结果进入会话历史，部分模型上游收到带空 data 的 image part 会挂起直到
 * 客户端超时（实测 kimi-k3 每次 ~105s 无响应后被自动重试），所以必须在这里显式失败。
 */
function harness(capturePage: () => Promise<unknown>) {
  const tab = {
    tabId: 'tab-1',
    commandTail: Promise.resolve(),
    lastActivityAt: 0,
    contents: { capturePage, isDestroyed: () => false },
    state: { url: 'profer-file://plugin/index.html', title: '', trace: [] as unknown[], visible: true },
  }
  const browserSession = {
    sessionId: 'session-1',
    tabs: new Map([[tab.tabId, tab]]),
    activeTabId: tab.tabId,
    agentTabId: tab.tabId,
    agentAbortController: new AbortController(),
    ledger: [] as unknown[],
    lastVisible: true,
  }
  const controller = new BrowserController()
  const internals = controller as unknown as { sessions: Map<string, unknown> }
  internals.sessions.set(browserSession.sessionId, browserSession)
  return { controller, tab }
}

test('Given 后台截图 When 请求 capturePage Then 保持隐藏且不唤起窗口', async () => {
  const args: unknown[][] = []
  const { controller } = harness(async (...input: unknown[]) => {
    args.push(input)
    return {
      isEmpty: () => false,
      toPNG: () => Buffer.from('test-png'),
      getSize: () => ({ width: 800, height: 600 }),
    }
  })
  await controller.screenshot('session-1')
  expect(args).toEqual([[undefined, { stayHidden: true }]])
})

test('capturePage 返回空图像时截图必须报错，不能产出空 image 工具结果', async () => {
  const { controller } = harness(async () => ({
    isEmpty: () => true,
    toPNG: () => Buffer.alloc(0),
    getSize: () => ({ width: 0, height: 0 }),
  }))

  await expect(controller.screenshot('session-1')).rejects.toThrow('截图为空')
})

test('PNG 编码为空字节时同样报错', async () => {
  const { controller } = harness(async () => ({
    isEmpty: () => false,
    toPNG: () => Buffer.alloc(0),
    getSize: () => ({ width: 10, height: 10 }),
  }))

  await expect(controller.screenshot('session-1')).rejects.toThrow('截图为空')
})

test('正常截图仍返回 base64', async () => {
  const png = Buffer.from('fake-png-bytes')
  const { controller } = harness(async () => ({
    isEmpty: () => false,
    toPNG: () => png,
    getSize: () => ({ width: 800, height: 600 }),
  }))

  const result = await controller.screenshot('session-1')
  expect(result.base64).toBe(png.toString('base64'))
  expect(result.mimeType).toBe('image/png')
  expect(result.url).toBe('profer-file://plugin/index.html')
})
