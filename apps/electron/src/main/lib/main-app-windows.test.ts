import { describe, expect, test } from 'bun:test'
import { IPC_CHANNELS } from '@profer/shared'
import {
  buildSessionTitleBarOptions,
  createSecondaryMainWindow,
  getMainWindowBootstrap,
  installSessionWindowChrome,
  installSessionWindowMaximizeNotifications,
  isMainAppWindowSender,
  normalizeInitialTab,
  registerMainAppWindow,
} from './main-app-windows'

let nextWebContentsId = 9000

function fakeWindow() {
  const id = nextWebContentsId++
  const webContents = {
    id,
    isDestroyed: () => false,
  }
  const win = {
    webContents,
    once: () => undefined,
  }
  return win as unknown as import('electron').BrowserWindow
}

function fakeChromeWindow() {
  const calls: string[] = []
  const win = {
    isDestroyed: () => false,
    isMaximized: () => false,
    on: () => undefined,
    setMenuBarVisibility: (visible: boolean) => { calls.push(`menu:${visible}`) },
    webContents: {
      send: () => undefined,
    },
  }
  return { win: win as unknown as import('electron').BrowserWindow, calls }
}

function fakeMaximizeWindow() {
  const handlers = new Map<string, () => void>()
  const sent: Array<{ channel: string; value: unknown }> = []
  let maximized = false
  const win = {
    isDestroyed: () => false,
    isMaximized: () => maximized,
    on: (event: string, handler: () => void) => { handlers.set(event, handler) },
    webContents: {
      send: (channel: string, value: unknown) => { sent.push({ channel, value }) },
    },
  }
  return {
    win: win as unknown as import('electron').BrowserWindow,
    handlers,
    sent,
    setMaximized: (value: boolean) => { maximized = value },
  }
}

describe('session window platform options', () => {
  test('Windows 使用自绘控制条并保留可缩放边框', () => {
    const options = buildSessionTitleBarOptions('win32')
    expect(options).toEqual({ titleBarStyle: 'hidden', thickFrame: true })
    expect('trafficLightPosition' in options).toBe(false)
    expect('vibrancy' in options).toBe(false)
    // 自绘 WindowControls 已经占了右上角，不能再启用原生 overlay。
    expect('titleBarOverlay' in options).toBe(false)
  })

  test('macOS 保留原生交通灯，不混入 Windows 选项', () => {
    const options = buildSessionTitleBarOptions('darwin')
    expect(options.titleBarStyle).toBe('hiddenInset')
    expect(options.trafficLightPosition).toEqual({ x: 18, y: 18 })
    expect(options.vibrancy).toBe('under-window')
    expect('thickFrame' in options).toBe(false)
  })

  test('Linux 沿用系统原生边框', () => {
    expect(buildSessionTitleBarOptions('linux')).toEqual({})
  })

  test('Windows 会话窗口推送自己的最大化状态', () => {
    const { win, handlers, sent, setMaximized } = fakeMaximizeWindow()
    installSessionWindowMaximizeNotifications(win, 'win32')
    expect([...handlers.keys()].sort()).toEqual(['maximize', 'restore', 'unmaximize'])

    setMaximized(true)
    handlers.get('maximize')?.()
    setMaximized(false)
    handlers.get('unmaximize')?.()

    expect(sent).toEqual([
      { channel: IPC_CHANNELS.WINDOW_MAXIMIZE_CHANGED, value: true },
      { channel: IPC_CHANNELS.WINDOW_MAXIMIZE_CHANGED, value: false },
    ])
  })

  test('非 Windows 不注册最大化推送，避免和主窗口重复', () => {
    const { win, handlers } = fakeMaximizeWindow()
    installSessionWindowMaximizeNotifications(win, 'darwin')
    expect(handlers.size).toBe(0)
  })

  test('Windows/Linux 隐藏原生菜单栏，macOS 交给系统全局菜单', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const { win, calls } = fakeChromeWindow()
      installSessionWindowChrome(win, platform)
      expect(calls).toEqual(['menu:false'])
    }

    const mac = fakeChromeWindow()
    installSessionWindowChrome(mac.win, 'darwin')
    expect(mac.calls).toEqual([])
  })
})

describe('main app window registry', () => {
  test('主窗口注册后能读到 primary 引导信息', () => {
    const win = fakeWindow()
    registerMainAppWindow(win, { isPrimary: true })
    expect(getMainWindowBootstrap(win.webContents)).toEqual({
      windowId: 'primary',
      kind: 'main',
      isPrimary: true,
      initialTab: null,
    })
    expect(isMainAppWindowSender(win.webContents)).toBe(true)
  })

  test('次级窗口保留初始 Tab 与独立窗口 ID', () => {
    const win = fakeWindow()
    registerMainAppWindow(win, {
      isPrimary: false,
      initialTab: { id: 'session-a', type: 'agent', sessionId: 'session-a', title: '会话 A' },
    })
    const bootstrap = getMainWindowBootstrap(win.webContents)
    expect(bootstrap?.kind).toBe('session')
    expect(bootstrap?.isPrimary).toBe(false)
    expect(bootstrap?.windowId).not.toBe('primary')
    expect(bootstrap?.initialTab).toMatchObject({ sessionId: 'session-a', type: 'agent' })
  })

  test('未注册的 webContents 不是合法来源', () => {
    expect(isMainAppWindowSender({ id: 1, isDestroyed: () => false } as never)).toBe(false)
    expect(getMainWindowBootstrap(null)).toBeNull()
  })

  test('非会话 Tab 拒绝创建新窗口（在触碰 screen 之前返回）', () => {
    expect(createSecondaryMainWindow({ type: 'preview', sessionId: 'x', title: 'x' })).toEqual({
      ok: false,
      error: '不支持的标签类型',
    })
  })

  test('拆窗载荷保留富文本草稿，纯文本为空也不丢引用', () => {
    const normalized = normalizeInitialTab({
      id: 'tab-quote',
      type: 'agent',
      sessionId: 'session-quote',
      title: '引用草稿',
      draftHtml: '<p><span data-quote-ref="1"></span></p>',
    })
    expect(normalized?.draft).toBeUndefined()
    expect(normalized?.draftHtml).toBe('<p><span data-quote-ref="1"></span></p>')
  })

  test('纯文本和富文本草稿都只交付一次，刷新不重放', () => {
    const win = fakeWindow()
    registerMainAppWindow(win, {
      isPrimary: false,
      initialTab: {
        id: 'tab-draft',
        type: 'agent',
        sessionId: 'session-draft',
        title: '草稿',
        draft: 'hello',
        draftHtml: '<p>hello</p>',
      },
    })
    expect(getMainWindowBootstrap(win.webContents)?.initialTab).toMatchObject({
      draft: 'hello',
      draftHtml: '<p>hello</p>',
    })
    const second = getMainWindowBootstrap(win.webContents)?.initialTab
    expect(second).not.toHaveProperty('draft')
    expect(second).not.toHaveProperty('draftHtml')
  })

  test('超长富文本草稿不进入窗口载荷', () => {
    const normalized = normalizeInitialTab({
      id: 'tab-long',
      type: 'agent',
      sessionId: 'session-long',
      title: '超长草稿',
      draftHtml: 'x'.repeat(500_001),
    })
    expect(normalized?.draftHtml).toBeUndefined()
  })
})
