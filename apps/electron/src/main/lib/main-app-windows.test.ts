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
  normalizeWindowSessions,
  isSecondaryWindowSessionOwner,
  reportWindowSessions,
  confirmWindowBootstrap,
  reportWindowPhase,
  setMainAppWindowsChangedHandler,
  notifyMainAppWindowsChanged,
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
    setWindowButtonVisibility: (visible: boolean) => { calls.push(`buttons:${visible}`) },
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
    expect(options.titleBarStyle).toBe('hidden')
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
    expect(mac.calls).toEqual(['buttons:false'])
  })
})

describe('main app window registry', () => {
  test('主窗口注册后能读到 primary 引导信息', () => {
    const win = fakeWindow()
    registerMainAppWindow(win, { isPrimary: true })
    expect(getMainWindowBootstrap(win.webContents)).toMatchObject({
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
    expect(bootstrap?.kind).toBe('main')
    expect(bootstrap?.isPrimary).toBe(false)
    expect(bootstrap?.windowId).not.toBe('primary')
    expect(bootstrap?.initialTab).toMatchObject({ sessionId: 'session-a', type: 'agent' })
  })

  test('未注册的 webContents 不是合法来源', () => {
    expect(isMainAppWindowSender({ id: 1, isDestroyed: () => false } as never)).toBe(false)
    expect(getMainWindowBootstrap(null)).toBeNull()
  })

  test('非会话 Tab 拒绝创建新窗口（在触碰 screen 之前返回）', async () => {
    expect(await createSecondaryMainWindow({ type: 'preview', sessionId: 'x', title: 'x' })).toEqual({
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

test('窗口会话集合验证、去重并拒绝非应用来源', () => {
  expect(normalizeWindowSessions([{ type: 'chat', sessionId: 'a' }, { type: 'chat', sessionId: 'a' }, { type: 'agent', sessionId: 'a' }])).toHaveLength(2)
  expect(() => normalizeWindowSessions([{ type: 'preview', sessionId: 'a' }])).toThrow()
  expect(() => reportWindowSessions({ id: -1, isDestroyed: () => false } as never, [])).toThrow()
  expect(() => confirmWindowBootstrap({ id: -1, isDestroyed: () => false } as never)).toThrow()
})

test('完整次级窗口上报全部会话且 bootstrap 返回防突变快照', () => {
  const win = fakeWindow()
  registerMainAppWindow(win, { isPrimary: false })
  reportWindowSessions(win.webContents, [{ type: 'agent', sessionId: 'one' }, { type: 'chat', sessionId: 'two' }])
  const bootstrap = getMainWindowBootstrap(win.webContents)!
  const summary = bootstrap.openWindows.find(item => item.windowId === bootstrap.windowId)!
  expect(summary.sessions).toEqual([{ type: 'agent', sessionId: 'one' }, { type: 'chat', sessionId: 'two' }])
  summary.sessions.length = 0
  expect(getMainWindowBootstrap(win.webContents)!.openWindows.find(item => item.windowId === bootstrap.windowId)!.sessions).toHaveLength(2)
  confirmWindowBootstrap(win.webContents)
})

test('次级归属依据真实角色与实际会话集合，不消费草稿', () => {
  const win = fakeWindow()
  registerMainAppWindow(win, { isPrimary: false, initialTab: { id: 'a', sessionId: 'a', type: 'agent', title: 'A', draft: 'draft' } })
  expect(isSecondaryWindowSessionOwner(win.webContents, { type: 'agent', sessionId: 'a' })).toBe(false)
  reportWindowSessions(win.webContents, [{ type: 'agent', sessionId: 'a' }])
  expect(isSecondaryWindowSessionOwner(win.webContents, { type: 'agent', sessionId: 'a' })).toBe(true)
  expect(isSecondaryWindowSessionOwner(win.webContents, { type: 'chat', sessionId: 'a' })).toBe(false)
  expect(getMainWindowBootstrap(win.webContents)?.initialTab?.draft).toBe('draft')
  reportWindowSessions(win.webContents, [])
  expect(isSecondaryWindowSessionOwner(win.webContents, { type: 'agent', sessionId: 'a' })).toBe(false)
})

test('pending bootstrap 重读保留唯一草稿，伪造或过期 handoff 不能确认', () => {
  const win = fakeWindow()
  const record = registerMainAppWindow(win, { isPrimary: false, initialTab: {
    id: 'escrow-tab', type: 'agent', sessionId: 'escrow', title: '托管', draft: 'recover me', draftHtml: '<p>recover me</p>',
  } })
  record.handoffId = 'pending-escrow'
  expect(getMainWindowBootstrap(win.webContents)?.handoffId).toBe('pending-escrow')
  expect(getMainWindowBootstrap(win.webContents)?.initialTab?.draft).toBe('recover me')
  expect(getMainWindowBootstrap(win.webContents)?.initialTab?.draftHtml).toBe('<p>recover me</p>')
  expect(() => confirmWindowBootstrap(win.webContents, 'wrong')).toThrow('标识不匹配')
  expect(() => confirmWindowBootstrap(win.webContents)).toThrow('标识不匹配')
})

test('生产建窗返回片段立即 accepted，不等待 Core 和 renderer confirm', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('./main-app-windows.ts', import.meta.url), 'utf8')
  const start = source.indexOf('  void coreReady.then')
  const end = source.indexOf('\n}\n', start)
  const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))
  let loaded = false
  const never = new Promise(() => {})
  const result = new Function('coreReady', 'record', 'win', 'loadRenderer', 'initialTab', 'handoffId', 'createdAt', 'logWindowPhase', body)(
    never, {}, {}, () => { loaded = true }, { type: 'agent', sessionId: 'pending' }, 'test-accepted', Date.now(), () => {},
  )
  expect(await result).toEqual({ ok: true, accepted: true, handoffId: 'test-accepted' })
  expect(loaded).toBe(true)
})

test('生产结束状态机：失败恢复快照、源关闭安全、旧回调不覆盖新交接', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('./main-app-windows.ts', import.meta.url), 'utf8')
  const start = source.indexOf('  record.completeBootstrap = value => {')
  const end = source.indexOf("  win.webContents.once('render-process-gone'", start)
  const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))
  for (const reason of ['目标窗口已关闭', '目标窗口初始化超时', '目标窗口渲染进程退出']) {
    const pending = new Map([['key', { id: 'old' }]])
    const recoverable = new Map()
    const record = { handoffId: 'old', initialTab: { draft: 'unique' }, completeBootstrap: undefined as undefined | ((value: { ok: boolean; error?: string }) => void) }
    let destroyed = 0
    const win = { webContents: {}, isDestroyed: () => false, destroy: () => { destroyed++ } }
    const args = { record, pending, key: 'key', handoffId: 'old', timer: undefined, recoverable, initialTab: { draft: 'unique', draftHtml: '<p>unique</p>' }, sourceCore: { targetId: 'remote', coreId: 'core-a' }, sourceWindow: { webContents: { isDestroyed: () => true } }, win, finishWindowHandoff: () => {}, notifyMainAppWindowsChanged: () => {}, createdAt: Date.now(), IPC_CHANNELS, logWindowPhase: () => {} }
    new Function(...Object.keys(args), compiled)(...Object.values(args))
    const oldFinish = record.completeBootstrap!
    oldFinish({ ok: false, error: reason })
    expect(recoverable.get('old')).toMatchObject({ status: 'failed', sourceCore: { targetId: 'remote', coreId: 'core-a' }, tab: { draft: 'unique', draftHtml: '<p>unique</p>' } })
    expect(destroyed).toBe(1)
    pending.set('key', { id: 'new' })
    oldFinish({ ok: true })
    expect(pending.get('key')?.id).toBe('new')
    expect(recoverable.size).toBe(1)
  }
})

test('生产 ACK 仅允许就绪且 Core 匹配的完整窗口消费失败记录', async () => {
 const { readFileSync } = await import('node:fs')
 const source = readFileSync(new URL('./main-app-windows.ts', import.meta.url), 'utf8')
 const from = source.indexOf('export function ackWindowTabHandoff(')
 const body = source.slice(from, source.indexOf('\n}\n', from) + 3)
 const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(body.replace('export function', 'function'))
 const recoverable = new Map([['failed', { sourceCore: { targetId: 'remote', coreId: 'a' } }]])
 let state = { startup: 'restoring' as string | undefined, currentId: 'remote', targets: [{ id: 'remote', coreId: 'a' }] }
 const ack = new Function('getRecordBySender', 'recoverable', 'runCoreWindow', 'listCoreTargets', `${compiled}; return ackWindowTabHandoff`)(
  (sender: { id: number }) => sender.id === 1, recoverable, (_id: number, fn: () => unknown) => fn(), () => state,
 )
 expect(() => ack({ id: 2 }, 'failed')).toThrow('完整应用窗口')
 expect(() => ack({ id: 1 }, 'pending')).toThrow('不存在')
 expect(() => ack({ id: 1 }, 'failed')).toThrow('尚未就绪')
 state.startup = undefined
 state.targets[0]!.coreId = 'b'
 expect(() => ack({ id: 1 }, 'failed')).toThrow('不匹配')
 state.targets[0]!.coreId = 'a'
 ack({ id: 1 }, 'failed')
 expect(recoverable.size).toBe(0)
 expect(() => ack({ id: 1 }, 'failed')).toThrow('不存在')
})


test('建窗同轮菜单通知合并并让出首次加载关键路径', async () => {
 let calls = 0
 setMainAppWindowsChangedHandler(() => { calls++ })
 notifyMainAppWindowsChanged()
 notifyMainAppWindowsChanged()
 expect(calls).toBe(0)
 await new Promise<void>(resolve => setImmediate(resolve))
 expect(calls).toBe(1)
 setMainAppWindowsChangedHandler(null)
})

test('阶段上报只接受完整窗口和固定枚举，不信任Renderer时间或字段', () => {
 expect(() => reportWindowPhase({ id: -999, isDestroyed: () => false } as never, 'app-ready')).toThrow('完整应用窗口')
 const win = fakeWindow()
 registerMainAppWindow(win, { isPrimary: false })
 expect(() => reportWindowPhase(win.webContents, { phase: 'app-ready', elapsedMs: 0 })).toThrow('无效窗口阶段')
 expect(() => reportWindowPhase(win.webContents, 'arbitrary')).toThrow('无效窗口阶段')
 expect(() => reportWindowPhase(win.webContents, 'app-ready')).not.toThrow()
})

test('confirm 清 pending 后仍记录原 handoff 的 interactive，刷新重复上报去重且无内容', async () => {
 const { readFileSync } = await import('node:fs')
 const source = readFileSync(new URL('./main-app-windows.ts', import.meta.url), 'utf8')
 const from = source.indexOf('const RENDERER_WINDOW_PHASES =')
 const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(from).replace('export function', 'function'))
 const records: Array<{ event: string; detail: Record<string, unknown> }> = []
 const record = {
   id: 'window-timing', handoffId: 'handoff-timing' as string | undefined,
   timingHandoffId: 'handoff-timing', createdAt: Date.now(), phases: new Set(),
   initialTab: { draft: 'private-content', sessionId: 'private-session' },
 }
 const report = new Function('getRecordBySender', 'logLifecycle', `${compiled}; return reportWindowPhase`)(
   (sender: { id: number }) => sender.id === 1 ? record : null,
   (event: string, detail: Record<string, unknown>) => records.push({ event, detail }),
 )
 // completeBootstrap 的实际 pending 清理赋值；独立 timing 不影响确认权限。
 record.handoffId = undefined
 report({ id: 1 }, 'target-interactive')
 report({ id: 1 }, 'target-interactive')
 expect(records).toHaveLength(1)
 expect(records[0]?.detail).toMatchObject({ handoffId: 'handoff-timing', windowId: 'window-timing', phase: 'target-interactive' })
 expect(Object.keys(records[0]!.detail).sort()).toEqual(['elapsedMs', 'handoffId', 'phase', 'windowId'])
 expect(JSON.stringify(records)).not.toContain('private')
 expect(record.handoffId).toBeUndefined()
 expect(() => report({ id: 2 }, 'target-interactive')).toThrow('完整应用窗口')
 expect(() => report({ id: 1 }, 'invalid')).toThrow('无效窗口阶段')
})

test('主窗口关闭连续接任：优先可见 ready 窗口，保持 ID、草稿和 Core，仅最后窗口隐藏', async () => {
  const { BrowserWindow } = await import('electron')
  const { getMainWindow } = await import('./main-window-state')
  const { setPrimaryWindowCloseHandler } = await import('./main-app-windows')
  const original = BrowserWindow.getAllWindows
  const windows: import('electron').BrowserWindow[] = []
  const handlers = new Map<import('electron').BrowserWindow, Map<string, () => void>>()
  const add = (primary: boolean, ready: boolean, visible = true) => {
    const callbacks = new Map<string, () => void>()
    const win = {
      webContents: { id: nextWebContentsId++, isDestroyed: () => false, send: () => {} },
      isDestroyed: () => false, isVisible: () => visible,
      once: (name: string, cb: () => void) => { callbacks.set(name, cb) },
      on: (name: string, cb: () => void) => { callbacks.set(name, cb) },
    } as unknown as import('electron').BrowserWindow
    windows.push(win)
    handlers.set(win, callbacks)
    const record = registerMainAppWindow(win, { isPrimary: primary, initialTab: { id: 'tab', type: 'chat', sessionId: 'session', title: 'Title', draft: 'untouched' } })
    if (ready) confirmWindowBootstrap(win.webContents)
    return { win, record }
  }
  BrowserWindow.getAllWindows = () => windows
  setPrimaryWindowCloseHandler(() => true)
  try {
    const primary = add(true, true)
    const loading = add(false, false)
    loading.record.handoffId = 'pending'
    const hidden = add(false, true, false)
    const ready = add(false, true)
    const id = ready.record.id
    windows.splice(windows.indexOf(primary.win), 1)
    handlers.get(primary.win)!.get('closed')!()
    expect(getMainWindow()).toBe(ready.win)
    expect(ready.record).toMatchObject({ id, kind: 'main', isPrimary: true, initialTab: { draft: 'untouched' } })
    expect(hidden.record.isPrimary).toBe(false)
    windows.splice(windows.indexOf(ready.win), 1)
    handlers.get(ready.win)!.get('closed')!()
    expect(getMainWindow()).toBe(hidden.win)
    windows.splice(windows.indexOf(hidden.win), 1)
    handlers.get(hidden.win)!.get('closed')!()
    expect(getMainWindow()).toBeNull()
  } finally {
    for (const win of [...windows]) handlers.get(win)?.get('closed')?.()
    BrowserWindow.getAllWindows = original
    setPrimaryWindowCloseHandler(null)
  }
})

test('生产主窗口关闭策略：有接任者真关闭，最后 Mac/Windows 托盘隐藏，退出不拦截', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
  const start = source.indexOf('setPrimaryWindowCloseHandler(win => {')
  const end = source.indexOf('\n})', start) + 3
  const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const quitting of [false, true]) {
      for (const successor of [false, true]) {
        let handler: (win: unknown) => boolean = () => false
        let hidden = 0
        let appHidden = 0
        const win = { isDestroyed: () => false, hide: () => { hidden++ }, isFullScreen: () => false }
        const args = {
          setPrimaryWindowCloseHandler: (cb: typeof handler) => { handler = cb },
          getIsQuitting: () => quitting, saveMainWindowState: () => {},
          findPrimaryWindowSuccessor: () => successor, process: { platform },
          getTray: () => true, app: { hide: () => { appHidden++ } },
          hasOtherVisibleMainWindow: () => false,
        }
        new Function(...Object.keys(args), compiled)(...Object.values(args))
        const close = handler(win)
        expect(close).toBe(quitting || successor || platform === 'linux')
        expect(hidden).toBe(close ? 0 : 1)
        expect(appHidden).toBe(!close && platform === 'darwin' ? 1 : 0)
      }
    }
  }
})

test('退出关闭主窗口不接任，旧 createWindow 回调不再引用可变全局窗口', async () => {
  const { readFileSync } = await import('node:fs')
  const { BrowserWindow } = await import('electron')
  const { setQuitting } = await import('./app-lifecycle')
  const { getMainWindow } = await import('./main-window-state')
  const original = BrowserWindow.getAllWindows
  const callbacks = new Map<string, () => void>()
  const win = {
    webContents: { id: nextWebContentsId++, isDestroyed: () => false },
    once: (event: string, cb: () => void) => { callbacks.set(event, cb) },
    on: () => {}, isDestroyed: () => false,
  } as unknown as import('electron').BrowserWindow
  try {
    registerMainAppWindow(win, { isPrimary: true })
    setQuitting(true)
    BrowserWindow.getAllWindows = () => { throw new Error('退出不得挑选新主窗口') }
    callbacks.get('closed')!()
    expect(getMainWindow()).toBeNull()
  } finally {
    BrowserWindow.getAllWindows = original
    setQuitting(false)
  }
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
  const createBody = source.slice(source.indexOf('function createWindow(): void {'), source.indexOf('\nfunction sendToMainWindow'))
  expect(createBody).toContain('const createdWindow = new BrowserWindow(')
  expect(createBody).not.toContain('mainWindow.webContents')
  expect(createBody).not.toContain('mainWindow = null')
  expect(createBody).not.toContain('setMainWindow(null)')
})
