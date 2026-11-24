import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { BrowserWindow, type WebContents } from 'electron'
import { IPC_CHANNELS as C, type MainWindowTabPayload, type PrepareWindowSessionMove, type AcceptWindowSessionMove, type WindowTabHandoffEvent } from '@profer/shared'
import { currentCoreWindow } from './core-window-scope'

const generation = new Map<number, number>()
const target = new Map<number, string>()
mock.module('./core-target-service', () => ({
  initializeWindowCore: async () => {}, disposeWindowCore: () => {},
  listCoreTargets: () => ({ currentId: target.get(currentCoreWindow()!) ?? 'local', generation: generation.get(currentCoreWindow()!) ?? 0,
    targets: [{ id: 'local', status: 'connected', coreId: 'l' }, { id: 'remote', status: 'connected', coreId: 'r' }] }),
}))
const { registerMainAppWindow, focusWindowForSession, replyToWindowMove, moveSessionToThisWindow, reportWindowSessions, getMainWindowBootstrap, setLocalHandoffRestore, isWindowTabHandoffPending } = await import('./main-app-windows')
const allWindows = BrowserWindow.getAllWindows
let id = 7000
const windows: BrowserWindow[] = []
beforeEach(() => { BrowserWindow.getAllWindows = () => windows })
afterEach(() => {
  setLocalHandoffRestore(undefined)
  for (const w of windows.splice(0)) w.emit('closed')
  BrowserWindow.getAllWindows = allWindows
})
function makeWindow(primary: boolean) {
  let focused = 0
  const wc = Object.assign(new EventEmitter(), { id: ++id, isDestroyed: () => false, send: (channel: string, value: unknown) => { wc.emit(channel, value) } })
  const win = Object.assign(new EventEmitter(), { webContents: wc, isDestroyed: () => false, isMinimized: () => false, show: () => {}, focus: () => { focused++ } }) as unknown as BrowserWindow
  windows.push(win)
  registerMainAppWindow(win, { isPrimary: primary })
  const session = { type: 'agent' as const, sessionId: 's' }
  const tab: MainWindowTabPayload = { ...session, id: 'tab', title: 'Title', draft: 'live text', draftHtml: '<p>live text</p>' }
  const commits: WindowTabHandoffEvent[] = []
  wc.on(C.WINDOW_TAB_HANDOFF, (event: WindowTabHandoffEvent) => commits.push(event))
  return { wc: win.webContents, events: wc, commits, session, tab, focused: () => focused }
}
function pair(sourcePrimary = true) {
  const source = makeWindow(sourcePrimary), dest = makeWindow(!sourcePrimary)
  reportWindowSessions(source.wc, [source.session])
  reportWindowSessions(dest.wc, [])
  const prepare = (snapshot: unknown = { tab: source.tab }) => source.events.once(C.WINDOW_MOVE_PREPARE, ({ handoffId }: PrepareWindowSessionMove) => replyToWindowMove(source.wc, handoffId, snapshot))
  const move = () => moveSessionToThisWindow(dest.wc, source.session, () => false)
  return { source, dest, prepare, move }
}
for (const sourcePrimary of [true, false]) {
  test(`primary=${sourcePrimary}: focus and move to another existing window preserve latest source draft`, async () => {
    const {source,dest,prepare,move} = pair(sourcePrimary)
    expect(await focusWindowForSession(dest.wc, source.session, () => source.tab)).toBe(true)
    expect(source.focused()).toBe(1)
    let restored: WebContents | undefined
    setLocalHandoffRestore(wc => { restored = wc })
    prepare()
    dest.events.once(C.WINDOW_MOVE_ACCEPT, (request: AcceptWindowSessionMove) => {
      expect(request.tab).toEqual(source.tab)
      expect(request.core).toEqual({targetId:'local',coreId:'l',generation:0})
      expect(isWindowTabHandoffPending(dest.wc,'s')).toBe(true)
      expect(source.commits).toHaveLength(0)
      reportWindowSessions(dest.wc, [source.session])
      replyToWindowMove(dest.wc,request.handoffId,{ok:true})
    })
    source.events.once(C.WINDOW_TAB_HANDOFF, () => reportWindowSessions(source.wc, []))
    expect(await move()).toEqual({ok:true})
    expect(source.commits).toHaveLength(1)
    expect(source.commits[0]).toMatchObject({existingWindowMove:true, status:'committed',sourceGeneration:0,tab:source.tab})
    expect(isWindowTabHandoffPending(dest.wc,'s')).toBe(false)
    expect(restored).toBe(dest.wc)
  })
}

test('拒绝异窗回复与重复请求；目标否认或未实际注册不提交', async () => {
  const {source,dest,move,prepare} = pair()
  let ready!: (req: PrepareWindowSessionMove) => void
  const requested = new Promise<PrepareWindowSessionMove>(resolve => { ready = resolve })
  source.events.once(C.WINDOW_MOVE_PREPARE, ready)
  const moving = move(), {handoffId} = await requested
  replyToWindowMove(dest.wc,handoffId,{tab:source.tab})
  expect(await move()).toMatchObject({ok:false,error:'会话正在移窗'})
  dest.events.once(C.WINDOW_MOVE_ACCEPT, ({handoffId}: AcceptWindowSessionMove) => replyToWindowMove(dest.wc,handoffId,{ok:false,error:'本地草稿冲突'}))
  replyToWindowMove(source.wc,handoffId,{tab:source.tab})
  expect(await moving).toEqual({ok:false,error:'本地草稿冲突'})
  prepare()
  dest.events.once(C.WINDOW_MOVE_ACCEPT, ({handoffId}: AcceptWindowSessionMove) => replyToWindowMove(dest.wc,handoffId,{ok:true}))
  expect(await move()).toMatchObject({ok:false,error:'目标窗口未确认会话归属'})
  expect(source.commits).toHaveLength(0)
})

test('单移子会话：保留父 ID，不传输或移除父标签', async () => {
  const {source,dest,move,prepare} = pair()
  const parent = {type:'agent' as const,sessionId:'parent'}
  reportWindowSessions(source.wc,[parent,source.session])
  prepare({tab:{...source.tab,parentSessionId:'parent'}})
  dest.events.once(C.WINDOW_MOVE_ACCEPT, (request: AcceptWindowSessionMove) => {
    expect(request.tab.parentSessionId).toBe('parent')
    reportWindowSessions(dest.wc,[source.session]); replyToWindowMove(dest.wc,request.handoffId,{ok:true})
  })
  source.events.once(C.WINDOW_TAB_HANDOFF, () => reportWindowSessions(source.wc, [parent]))
  expect(await move()).toEqual({ok:true}); expect(source.commits[0]?.tab.sessionId).toBe(source.session.sessionId)
})

test('无效父 ID、会话替换、超限草稿、生成中的 Chat 不发送到目标', async () => {
  const {source,dest,move,prepare} = pair()
  let accepts = 0
  dest.events.on(C.WINDOW_MOVE_ACCEPT, () => { accepts++ })
  for (const tab of [{...source.tab,parentSessionId:'x'.repeat(201)},{...source.tab,sessionId:'replaced'},{...source.tab,draft:'x'.repeat(100_001)}]) {
    prepare({tab}); expect((await move()).ok).toBe(false)
  }
  const chat = {type:'chat',sessionId:'c'}
  reportWindowSessions(source.wc,[chat])
  expect(await moveSessionToThisWindow(dest.wc,chat,()=>true)).toMatchObject({ok:false,error:'生成中的 Chat 暂不支持移窗'})
  expect(accepts).toBe(0)
  expect(source.commits).toHaveLength(0)
})

test('目标刷新或跨 generation 不提交；源退出后托管已取得的草稿', async () => {
  const {source,dest,move,prepare} = pair()
  prepare()
  dest.events.once(C.WINDOW_MOVE_ACCEPT, () => dest.events.emit('did-start-loading'))
  expect((await move()).ok).toBe(false)
  prepare()
  dest.events.once(C.WINDOW_MOVE_ACCEPT, ({handoffId}: AcceptWindowSessionMove) => {
    generation.set(dest.wc.id,17)
    replyToWindowMove(dest.wc,handoffId,{ok:true})
  })
  expect((await move()).ok).toBe(false)
  prepare()
  dest.events.once(C.WINDOW_MOVE_ACCEPT, () => source.events.emit('destroyed'))
  expect((await move()).ok).toBe(false)
  expect(source.commits).toHaveLength(0)
  expect(getMainWindowBootstrap(source.wc)?.recoverableHandoffs?.at(-1)?.tab).toEqual(source.tab)
})

test('路由不匹配、来源消失及多重归属时不猜测、不自动切换 Core', async () => {
  const {source,dest,move} = pair()
  target.set(dest.wc.id,'remote')
  expect((await move()).ok).toBe(false)
  expect(await focusWindowForSession(dest.wc,source.session,() => source.tab)).toBe(false)
  target.delete(dest.wc.id)
  const another = makeWindow(false)
  reportWindowSessions(another.wc,[source.session])
  expect((await move()).ok).toBe(false)
  reportWindowSessions(another.wc,[])
  reportWindowSessions(source.wc,[])
  expect((await move()).ok).toBe(false)
  expect(source.commits).toHaveLength(0)
})
