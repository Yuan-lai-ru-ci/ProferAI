import { describe, expect, test } from 'bun:test'

import { BrowserController } from './browser-controller'

/**
 * 回归：子资源路由必须按 webContents id 跨**所有**会话定位标签。
 *
 * 现场：全局单一 profile（`resolveBrowserProfileKey` 恒返回 `global-browser-profile`）下，所有会话
 * 共用同一个 Electron Session 对象。旧实现先 `find((record) => record.browserSession === browserSession)`
 * 挑一个会话，该条件恒真、只会命中最早创建的那个 record；于是后续会话的标签永远定位不到，
 * `topLevelUrl` 落到空串、`new URL('')` 抛错、被 `.catch` 判成 cancel —— 页面只剩裸 HTML
 * （CSS/图片/脚本全部加载失败，主文档却正常）。重启后 record 清空只剩一个，故“重启就好”。
 */

interface FakeTab {
  tabId: string
  contents: { id: number; isDestroyed: () => boolean }
  state: { url: string }
  lastRequestedUrl: string | null
}

function makeTab(tabId: string, webContentsId: number, url = ''): FakeTab {
  return {
    tabId,
    contents: { id: webContentsId, isDestroyed: () => false },
    state: { url },
    lastRequestedUrl: url || null,
  }
}

interface Internals {
  sessions: Map<string, unknown>
  installSessionGuards: (browserSession: unknown) => void
  findTabEntryByWebContentsId: (webContentsId: number | undefined) => { sessionId: string; tab: FakeTab } | undefined
}

/** 两个会话共用同一个 Electron Session 对象 —— 这正是全局单一 profile 的真实形态。 */
function twoSharedSessions() {
  const controller = new BrowserController()
  const internals = controller as unknown as Internals
  const sharedSession = { partition: 'persist:profer-browser-shared' }
  const olderTab = makeTab('tab-older', 101, 'https://older.example.com/')
  const newerTab = makeTab('tab-newer', 202, 'https://profer.cn/')
  internals.sessions = new Map([
    ['session-older', { sessionId: 'session-older', browserSession: sharedSession, tabs: new Map([[olderTab.tabId, olderTab]]) }],
    ['session-newer', { sessionId: 'session-newer', browserSession: sharedSession, tabs: new Map([[newerTab.tabId, newerTab]]) }],
  ])
  return { internals, newerTab }
}

describe('受管浏览器子资源路由', () => {
  test('跨会话定位标签，不因共用同一 Electron Session 而只认最早的那个', () => {
    const { internals } = twoSharedSessions()

    expect(internals.findTabEntryByWebContentsId(202)?.sessionId).toBe('session-newer')
    expect(internals.findTabEntryByWebContentsId(202)?.tab.tabId).toBe('tab-newer')
    expect(internals.findTabEntryByWebContentsId(101)?.sessionId).toBe('session-older')
    expect(internals.findTabEntryByWebContentsId(999)).toBeUndefined()
    expect(internals.findTabEntryByWebContentsId(undefined)).toBeUndefined()
  })

  test('视图已销毁的标签被跳过，不影响后续标签的查找', () => {
    const { internals } = twoSharedSessions()
    const brokenTab = {
      tabId: 'tab-broken',
      get contents(): never { throw new Error('页面已销毁') },
      state: { url: 'https://broken.example.com/' },
      lastRequestedUrl: 'https://broken.example.com/',
    }
    const sessions = internals.sessions as Map<string, { tabs: Map<string, unknown> }>
    const newer = sessions.get('session-newer')
    if (!newer) throw new Error('夹具缺失')
    sessions.set('session-newer', {
      ...newer,
      tabs: new Map([[brokenTab.tabId, brokenTab], ...newer.tabs]),
    })

    expect(internals.findTabEntryByWebContentsId(202)?.tab.tabId).toBe('tab-newer')
  })

  test('第二个会话的样式/图片子资源不得被 cancel，私网子资源仍然拒绝', async () => {
    const { internals } = twoSharedSessions()

    let handler: ((details: unknown, callback: (result: { cancel: boolean }) => void) => void) | undefined
    internals.installSessionGuards({
      setPermissionRequestHandler: () => undefined,
      setCertificateVerifyProc: () => undefined,
      webRequest: { onBeforeRequest: (listener: typeof handler) => { handler = listener } },
      on: () => undefined,
    })
    if (!handler) throw new Error('未捕获到 onBeforeRequest handler')

    const decide = (details: Record<string, unknown>) =>
      new Promise<{ cancel: boolean }>((resolve) => { handler?.(details, resolve) })

    // 关键回归：这个请求属于“第二个会话”，旧实现会因为定位不到标签而一律 cancel。
    await expect(decide({ url: 'https://profer.cn/_astro/about.GXzutYYl.css', resourceType: 'stylesheet', webContentsId: 202 }))
      .resolves.toEqual({ cancel: false })
    await expect(decide({ url: 'https://profer.cn/images/profer-desktop-agent.png', resourceType: 'image', webContentsId: 202 }))
      .resolves.toEqual({ cancel: false })

    // 安全边界不放松：顶层是公网页面时，指向本机/私网的子资源仍必须拒绝。
    await expect(decide({ url: 'http://127.0.0.1:3000/admin', resourceType: 'xhr', webContentsId: 202 }))
      .resolves.toEqual({ cancel: true })

    // 带认证信息的 HTTP 子资源仍被拒绝（这一条会真正走到子资源策略函数）。
    await expect(decide({ url: 'https://user:pass@example.com/app.js', resourceType: 'script', webContentsId: 202 }))
      .resolves.toEqual({ cancel: true })

    // 非 HTTP(S)/WS 协议在 webRequest 层直接放行，交给 Chromium 处理内部协议（如 profer-file:）。
    await expect(decide({ url: 'data:text/plain,ok', resourceType: 'image', webContentsId: 202 }))
      .resolves.toEqual({ cancel: false })
  })

  test('定位不到标签时公网子资源放行，私网子资源仍拒绝', async () => {
    const { internals } = twoSharedSessions()

    let handler: ((details: unknown, callback: (result: { cancel: boolean }) => void) => void) | undefined
    internals.installSessionGuards({
      setPermissionRequestHandler: () => undefined,
      setCertificateVerifyProc: () => undefined,
      webRequest: { onBeforeRequest: (listener: typeof handler) => { handler = listener } },
      on: () => undefined,
    })
    if (!handler) throw new Error('未捕获到 onBeforeRequest handler')

    const decide = (details: Record<string, unknown>) =>
      new Promise<{ cancel: boolean }>((resolve) => { handler?.(details, resolve) })

    await expect(decide({ url: 'https://cdn.example.com/app.js', resourceType: 'script', webContentsId: 777 }))
      .resolves.toEqual({ cancel: false })
    await expect(decide({ url: 'http://192.168.1.10/api', resourceType: 'xhr', webContentsId: 777 }))
      .resolves.toEqual({ cancel: true })
  })
})
