/** 独立进程验证真实 controller 的后台目标/窗口行为；只使用临时 profile 与本机 fixture。 */
import { app, BrowserWindow, ipcMain, protocol, webContents } from 'electron'
import { AGENT_IPC_CHANNELS, type BrowserGuestVisibility } from '@profer/shared'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserController } from '../src/main/lib/browser-controller'
import { BROWSER_RISK_DISCLAIMER_VERSION } from '../src/types/settings'

protocol.registerSchemesAsPrivileged([{ scheme: 'profer-browser-dialog', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }])

const root = mkdtempSync(join(tmpdir(), 'profer-browser-controller-smoke-'))
process.env.PROFER_CONFIG_DIR = join(root, 'config')
mkdirSync(process.env.PROFER_CONFIG_DIR, { recursive: true })
// 只初始化隔离测试配置，不读取/改动用户确认状态。
writeFileSync(join(process.env.PROFER_CONFIG_DIR, 'settings.json'), JSON.stringify({ browserRiskDisclaimerVersion: BROWSER_RISK_DISCLAIMER_VERSION }))
app.setPath('userData', join(root, 'userData'))
const artifacts = join(__dirname, 'artifacts')
mkdirSync(artifacts, { recursive: true })
const checks: Array<{ name: string; passed: boolean; required?: boolean; details: unknown }> = []
function check(name: string, passed: boolean, details: unknown = null): void {
  checks.push({ name, passed, details })
  if (!passed) throw new Error(`断言失败：${name}`)
}
const delay = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds))
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  if (req.url === '/slow') {
    res.write('<!doctype html><title>slow</title><h1>加载中</h1>')
    return
  }
  res.end(`<!doctype html><meta charset="utf-8"><title>${req.url}</title><input id="field" value="initial"><h1>${req.url}</h1><p>Needle needle Needle</p><a href="/popup" target="_blank">新页</a>`)
})
const controller = new BrowserController()
let owner: BrowserWindow | undefined
let guardWindow: BrowserWindow | undefined
let finished = false
const deadline = setTimeout(() => finish(new Error('真实 controller smoke 90 秒截止')), 90_000)
function finish(error?: unknown): void {
  if (finished) return
  finished = true
  clearTimeout(deadline)
  writeFileSync(join(artifacts, 'results.json'), JSON.stringify({ electron: process.versions.electron, platform: process.platform, root, checks, error: error instanceof Error ? error.stack : error ?? null }, null, 2))
  console.log(JSON.stringify({ artifacts, checks, error: error instanceof Error ? error.message : error ?? null }))
  controller.dispose()
  owner?.destroy()
  guardWindow?.destroy()
  server.closeAllConnections()
  server.close()
  app.exit(error ? 1 : 0)
}
async function run(): Promise<void> {
  await app.whenReady()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture 未监听')
  const base = `http://127.0.0.1:${address.port}`
  owner = new BrowserWindow({ show: false, width: 1000, height: 750, webPreferences: { preload: join(__dirname, 'preload.cjs'), webviewTag: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  controller.setOwnerWindow(owner)
  ipcMain.handle(AGENT_IPC_CHANNELS.CONNECT_BROWSER_GUEST_HOST, event => {
    if (event.sender !== owner?.webContents) throw new Error('not fixture owner')
    return controller.connectGuestHost()
  })
  ipcMain.handle(AGENT_IPC_CHANNELS.BIND_BROWSER_GUEST, (event, claim: import('@profer/shared').BrowserGuestClaim) => {
    if (!owner || owner.isDestroyed() || event.sender !== owner.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('not fixture owner')
    controller.bindGuest(claim)
  })
  ipcMain.on(AGENT_IPC_CHANNELS.SET_BROWSER_GUEST_VISIBILITY, (event, pages: BrowserGuestVisibility[]) => {
    if (owner && !owner.isDestroyed() && event.sender === owner.webContents) controller.setGuestVisibility(pages)
  })
  ipcMain.on(AGENT_IPC_CHANNELS.SET_BROWSER_SHORTCUT_CONTEXT, (event, context: import('@profer/shared').BrowserShortcutContext) => {
    if (!owner || event.sender !== owner.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('not fixture owner')
    controller.setShortcutContext(context)
  })
  ipcMain.handle('smoke:get-settings', () => ({ browserRiskDisclaimerVersion: BROWSER_RISK_DISCLAIMER_VERSION }))
  ipcMain.handle('smoke:get-browser-start-page', () => ({ bookmarks: [], recentHistory: [], defaultHomeUrl: null }))
  ipcMain.handle(AGENT_IPC_CHANNELS.NAVIGATE_BROWSER, (_event, input: { sessionId: string; tabId?: string; url: string }) => controller.navigateDisplay(input.sessionId, input.url, input.tabId))
  ipcMain.handle(AGENT_IPC_CHANNELS.GO_BACK_BROWSER, (_event, sessionId: string, tabId?: string) => controller.goBackDisplay(sessionId, tabId))
  ipcMain.handle(AGENT_IPC_CHANNELS.GO_FORWARD_BROWSER, (_event, sessionId: string, tabId?: string) => controller.goForwardDisplay(sessionId, tabId))
  ipcMain.handle(AGENT_IPC_CHANNELS.RELOAD_BROWSER, (_event, sessionId: string, tabId?: string) => controller.reloadDisplay(sessionId, tabId))
  ipcMain.handle(AGENT_IPC_CHANNELS.STOP_BROWSER_PAGE, (_event, input: { sessionId: string; tabId: string }) => controller.stopDisplay(input.sessionId, input.tabId))
  ipcMain.handle(AGENT_IPC_CHANNELS.FIND_BROWSER_PAGE, (_event, input: { sessionId: string; tabId: string } & import('@profer/shared').BrowserFindInput) => controller.findDisplay(input.sessionId, input.tabId, input))
  ipcMain.handle(AGENT_IPC_CHANNELS.CLEAR_BROWSER_FIND, (_event, input: { sessionId: string; tabId: string }) => controller.clearFindDisplay(input.sessionId, input.tabId))
  ipcMain.handle(AGENT_IPC_CHANNELS.RESPOND_BROWSER_DIALOG, (_event, input: { sessionId: string; tabId: string } & import('@profer/shared').BrowserDialogResponse) => controller.respondToDialog(input.sessionId, input.tabId, input))
  await owner.loadFile(join(__dirname, 'index.html'))
  const js = <T>(expression: string): Promise<T> => owner!.webContents.executeJavaScript(expression) as Promise<T>
  const wait = async (expression: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await js<boolean>(expression)) return
      await delay(40)
    }
    throw new Error(`fixture 等待超时：${expression}; state=${JSON.stringify(controller.getState('s1')?.tabs.map(page => ({ tabId: page.tabId, find: page.find, dialog: page.dialog?.type })))}`)
  }
  let showEvents = 0
  let focusEvents = 0
  owner.on('show', () => { showEvents++ })
  owner.on('focus', () => { focusEvents++ })
  controller.setOwnerWindow(owner)
  controller.configureSession('s1', { profileKey: 'controller-smoke-only', executionSource: 'goal' })
  const shortcutEvents: Array<{ shortcutId: string; tabId: string }> = []
  owner.webContents.on('ipc-message', (_event, channel, payload) => {
    if (channel === AGENT_IPC_CHANNELS.BROWSER_SHORTCUT && payload) shortcutEvents.push({ shortcutId: payload.shortcutId, tabId: payload.tabId })
  })
  controller.setForegroundSession('s1')
  const nativeChildrenBefore = owner.contentView.children.length
  const display = await controller.createDisplayTab('s1', `${base}/user`)
  console.log('[smoke] display created')
  const work = await controller.createNewTab('s1', `${base}/agent`)
  console.log('[smoke] worker created')
  check('new-agent-keeps-display', controller.getState('s1')?.activeTabId === display.activeTabId, { display: display.activeTabId, target: work.tabId })
  check('action-result-is-target', work.url === `${base}/agent` && work.activeTabId === display.activeTabId, work.url)
  check('no-native-page-view', owner.contentView.children.length === nativeChildrenBefore, { before: nativeChildrenBefore, after: owner.contentView.children.length })
  check('hidden-window-never-shown', !owner.isVisible() && showEvents === 0 && focusEvents === 0, { showEvents, focusEvents })
  const pageEnvironment = await controller.evaluate('s1', "({node:typeof globalThis['process'],require:typeof globalThis['require'],bridge:typeof globalThis['electronAPI']})")
  const environment = pageEnvironment.result as { node?: unknown; require?: unknown; bridge?: unknown }
  check('product-guest-has-no-node-or-preload-bridge', environment.node === 'undefined' && environment.require === 'undefined' && environment.bridge === 'undefined', pageEnvironment.result)
  const boundRequest = controller.getGuestRequests().find(request => request.tabId === work.tabId)
  if (!boundRequest) throw new Error('缺少已绑定页面请求')
  const guestIdForReplay = await owner.webContents.executeJavaScript(`Array.from(document.querySelectorAll('webview')).find(node=>JSON.parse(node.dataset.browserGuestKey)[1]===${JSON.stringify(work.tabId)}).getWebContentsId()`)
  const replayRejected = await owner.webContents.executeJavaScript(`window.electronAPI.bindBrowserGuest(${JSON.stringify({ sessionId: 's1', tabId: work.tabId, ticket: boundRequest.ticket, guestId: guestIdForReplay })}).then(()=>false,()=>true)`)
  check('product-ipc-rejects-consumed-ticket', replayRejected === true)
  const observed = await controller.observe('s1')
  check('hidden-observe-target', observed.url === `${base}/agent`, observed.url)
  await controller.domAction('s1', { action: 'fill', selector: '#field', text: '后台中文输入 preserved' })
  const value = await controller.evaluate('s1', "document.querySelector('#field').value")
  const screenshot = await controller.screenshot('s1')
  check('hidden-guest-screenshot', screenshot.base64.length > 0)
  writeFileSync(join(artifacts, 'hidden-guest.png'), Buffer.from(screenshot.base64, 'base64'))
  check('hidden-fill-evaluate', value.result === '后台中文输入 preserved', value.result)
  controller.selectAgentTab('s1', work.tabId)
  const previewPath = join(root, 'sample.html')
  writeFileSync(previewPath, '<h1>只读本地测试</h1>')
  const preview = await controller.previewOpen('s1', previewPath, undefined, [root])
  console.log('[smoke] preview opened')
  check('preview-keeps-user-page', preview.tabId !== display.activeTabId && controller.getState('s1')?.activeTabId === display.activeTabId)
  check('all-hidden-actions-no-focus', !owner.isVisible() && focusEvents === 0 && showEvents === 0)
  // 生产协议必须保留同步网页语义，同时拒绝隐藏 pane 的 UI 回应。
  const backgroundDialog = controller.evaluate('s1', "confirm('后台等待确认')", work.tabId)
  for (let attempt = 0; attempt < 100 && !controller.getState('s1')?.tabs.find(page => page.tabId === work.tabId)?.dialog; attempt++) await delay(30)
  const hiddenDialog = controller.getState('s1')?.tabs.find(page => page.tabId === work.tabId)?.dialog
  check('hidden-confirm-pending-without-window', !!hiddenDialog && !owner.isVisible() && focusEvents === 0 && showEvents === 0)
  const hiddenResponseRejected = await controller.respondToDialog('s1', work.tabId, { dialogId: hiddenDialog!.id, accept: true }).then(() => false, () => true)
  check('hidden-pane-cannot-accept-dialog', hiddenResponseRejected)
  // 模拟关闭/放弃文档，只取消，不由测试代为确认。
  controller.stopDisplay('s1', work.tabId)
  // 页面Stop应解除当前等待，不能永久占用Agent操作队列。
  const backgroundValue = await backgroundDialog
  check('stop-cancels-hidden-dialog', backgroundValue.result === false)

  // 同一测试进程里的另一窗口模拟用户正在别处工作；不激活/读取用户其它应用。
  guardWindow = new BrowserWindow({ show: false, width: 400, height: 200 })
  await guardWindow.loadURL('data:text/html,<h1>用户当前工作窗口 fixture</h1>')
  owner.showInactive()
  guardWindow.show()
  guardWindow.focus()
  const focusBefore = focusEvents
  const showBefore = showEvents
  controller.selectAgentTab('s1', work.tabId)
  await controller.navigate('s1', `${base}/agent-next`)
  check('visible-unfocused-actions-no-focus', !owner.isFocused() && focusEvents === focusBefore && showEvents === showBefore, { focusBefore, focusEvents, showBefore, showEvents })
  check('display-still-user-after-navigation', controller.getState('s1')?.url === `${base}/user`)
  await owner.webContents.executeJavaScript(`dispatchEvent(new CustomEvent('smoke-pages',{detail:${JSON.stringify([display.activeTabId, work.tabId])}}))`)
  await new Promise(resolve => setTimeout(resolve, 300))
  check('two-guests-visible', await owner.webContents.executeJavaScript("[...document.querySelectorAll('webview')].filter(node=>getComputedStyle(node).opacity==='1').length") === 2)
  writeFileSync(join(artifacts, 'two-guest-panes.png'), (await owner.webContents.capturePage()).toPNG())
  const identityBefore = await owner.webContents.executeJavaScript("[...document.querySelectorAll('webview')].map(node=>node.getWebContentsId())")
  await owner.webContents.executeJavaScript("dispatchEvent(new CustomEvent('smoke-pages',{detail:[]}))")
  await new Promise(resolve => setTimeout(resolve, 150))
  await owner.webContents.executeJavaScript(`dispatchEvent(new CustomEvent('smoke-pages',{detail:${JSON.stringify([work.tabId])}}))`)
  await new Promise(resolve => setTimeout(resolve, 150))
  const identityAfter = await owner.webContents.executeJavaScript("[...document.querySelectorAll('webview')].map(node=>node.getWebContentsId())")
  console.log('[smoke] pane toggle finished')
  check('pane-toggle-keeps-guest-identity', JSON.stringify(identityBefore) === JSON.stringify(identityAfter))

  // 使用真正的产品工具栏、页面菜单与分屏退出控件，验证局部 guest 层叠/定位。
  await js(`dispatchEvent(new CustomEvent('smoke-options',{detail:{panels:true}}));dispatchEvent(new CustomEvent('smoke-pages',{detail:${JSON.stringify([display.activeTabId, work.tabId])}}))`)
  controller.selectTab('s1', display.activeTabId)
  await wait("document.querySelectorAll('[data-browser-guest-slot]').length===2 && document.querySelectorAll('button[aria-label^=\"所有浏览器页面\"]').length===2")
  await delay(160)
  const geometry = await js<Array<{ tab: string; error: number }>>(`Array.from(document.querySelectorAll('[data-browser-guest-slot]')).map(slot=>{const guest=Array.from(document.querySelectorAll('webview')).find(node=>JSON.parse(node.dataset.browserGuestKey)[1]===slot.closest('[data-fixture-panel]').dataset.fixturePanel);const a=slot.getBoundingClientRect(),b=guest.getBoundingClientRect();return {tab:slot.closest('[data-fixture-panel]').dataset.fixturePanel,error:Math.max(Math.abs(a.left-b.left),Math.abs(a.top-b.top),Math.abs(a.width-b.width),Math.abs(a.height-b.height))}})`)
  check('product-panel-nested-host-alignment', geometry.every(item => item.error <= 1), geometry)
  const userPane = `[data-fixture-panel=${JSON.stringify(display.activeTabId)}]`
  const setInput = async (selector: string, value: string): Promise<void> => {
    await js(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  }
  await js(`document.querySelector(${JSON.stringify(`${userPane} button[aria-label="在网页中查找"]`)}).click()`)
  await wait(`document.querySelector(${JSON.stringify(`${userPane} input[aria-label="查找网页内容"]`)})!==null`)
  await setInput(`${userPane} input[aria-label="查找网页内容"]`, 'Needle')
  await wait(`document.querySelector(${JSON.stringify(`${userPane} [role=search] [role=status]`)})?.textContent==='1/3'`)
  check('product-find-count-is-page-scoped', !controller.getState('s1')?.tabs.find(page => page.tabId === work.tabId)?.find)
  await js(`document.querySelector(${JSON.stringify(`${userPane} button[aria-label="下一个匹配"]`)}).click()`)
  await wait(`document.querySelector(${JSON.stringify(`${userPane} [role=search] [role=status]`)})?.textContent==='2/3'`)
  await js(`document.querySelector(${JSON.stringify(`${userPane} button[aria-label="上一个匹配"]`)}).click()`)
  await wait(`document.querySelector(${JSON.stringify(`${userPane} [role=search] [role=status]`)})?.textContent==='1/3'`)
  check('product-find-next-and-previous', true)
  await js(`document.querySelector(${JSON.stringify(`${userPane} button[aria-label="区分大小写"]`)}).click()`)
  await wait(`/^[12]\\/2$/.test(document.querySelector(${JSON.stringify(`${userPane} [role=search] [role=status]`)})?.textContent ?? '')`)
  check('product-find-match-case', controller.getState('s1')?.tabs.find(page => page.tabId === display.activeTabId)?.find?.matchCase === true
    && controller.getState('s1')?.tabs.find(page => page.tabId === display.activeTabId)?.find?.matches === 2)
  writeFileSync(join(artifacts, 'product-panel-find.png'), (await owner.webContents.capturePage()).toPNG())
  await js(`document.querySelector(${JSON.stringify(`${userPane} input[aria-label="查找网页内容"]`)}).focus()`)
  owner.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  owner.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await wait(`document.querySelector(${JSON.stringify(`${userPane} [role=search]`)})===null`)
  check('product-find-escape-clears-highlight', !controller.getState('s1')?.tabs.find(page => page.tabId === display.activeTabId)?.find)
  // 真实renderer快捷键注册表：只检查owner DOM路径；系统guest/menu焦点仍另列验收。
  await js("dispatchEvent(new KeyboardEvent('keydown',{key:'l',metaKey:true,bubbles:true}))")
  await wait(`document.activeElement===document.querySelector(${JSON.stringify(`${userPane} input[aria-label="浏览器地址"]`)})`)
  await delay(180)
  const addressGeometry = await js<{ width: number; toolbarWidth: number }>(`(()=>{const input=document.querySelector(${JSON.stringify(`${userPane} input[aria-label="浏览器地址"]`)});return {width:input.getBoundingClientRect().width,toolbarWidth:input.closest('[data-browser-toolbar]').getBoundingClientRect().width}})()`)
  check('product-address-expands-within-narrow-pane', addressGeometry.width > addressGeometry.toolbarWidth * 0.6, addressGeometry)
  writeFileSync(join(artifacts, 'product-panel-address.png'), (await owner.webContents.capturePage()).toPNG())
  check('product-address-shortcut-selects-url', await js<boolean>("document.activeElement.selectionEnd-document.activeElement.selectionStart===document.activeElement.value.length"))
  await setInput(`${userPane} input[aria-label="浏览器地址"]`, 'draft.test/preserved')
  await controller.navigate('s1', `${base}/agent-during-address-edit`, work.tabId)
  check('product-agent-push-preserves-address-draft', await js<string>(`document.querySelector(${JSON.stringify(`${userPane} input[aria-label="浏览器地址"]`)}).value`) === 'draft.test/preserved')
  await js(`document.querySelector(${JSON.stringify(`${userPane} input[aria-label="浏览器地址"]`)}).blur()`)
  await controller.navigate('s1', `${base}/agent-next`, work.tabId)
  const workPane = `[data-fixture-panel=${JSON.stringify(work.tabId)}]`
  const slowNavigation = controller.navigateDisplay('s1', `${base}/slow`, work.tabId)
  await wait(`document.querySelector(${JSON.stringify(`${workPane} button[aria-label="停止网页加载"]`)})!==null`)
  await js(`document.querySelector(${JSON.stringify(`${workPane} button[aria-label="停止网页加载"]`)}).click()`)
  await slowNavigation.catch(() => undefined)
  check('product-page-stop-keeps-agent-running', controller.getState('s1')?.tabs.find(page => page.tabId === work.tabId)?.loading === false
    && controller.getState('s1')?.agentTabId === work.tabId)
  await controller.navigateDisplay('s1', `${base}/agent-next`, work.tabId)
  check('page-stop-allows-next-navigation', (await controller.evaluate('s1', 'location.href', work.tabId)).result === `${base}/agent-next`)
  const dialogStartFocus = focusEvents
  const dialogStartShow = showEvents
  const dialogValue = controller.evaluate('s1', "confirm('仅工作页确认')", work.tabId)
  await wait(`${JSON.stringify(workPane)} && document.querySelector(${JSON.stringify(`${workPane} [data-browser-script-dialog]`)})!==null`)
  await delay(100)
  check('product-dialog-only-target-pane', await js<number>("document.querySelectorAll('[data-browser-script-dialog]').length") === 1
    && await js<boolean>(`getComputedStyle(Array.from(document.querySelectorAll('webview')).find(node=>JSON.parse(node.dataset.browserGuestKey)[1]===${JSON.stringify(work.tabId)})).opacity==='0'`))
  check('dialog-visible-pane-stays-authorized', controller.getState('s1')?.tabs.find(page => page.tabId === work.tabId)?.visible === true)
  const dialogHit = await js<boolean>(`(()=>{const node=document.querySelector(${JSON.stringify(`${workPane} [data-browser-script-dialog]`)}),r=node.getBoundingClientRect();return !!document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('[data-browser-script-dialog]')})()`)
  check('product-dialog-has-dom-hit-target', dialogHit)
  writeFileSync(join(artifacts, 'product-panel-confirm.png'), (await owner.webContents.capturePage()).toPNG())
  await js(`Array.from(document.querySelectorAll(${JSON.stringify(`${workPane} [role=dialog] button`)})).find(node=>node.textContent==='确定').click()`)
  check('product-confirm-response-unblocks-agent-queue', (await dialogValue).result === true)
  await wait("document.querySelectorAll('[data-browser-script-dialog]').length===0")
  const promptValue = controller.evaluate('s1', "prompt('中文输入','默认')", work.tabId)
  await wait(`document.querySelector(${JSON.stringify(`${workPane} input[aria-label="网页请求输入"]`)})!==null`)
  await js(`(()=>{const node=document.querySelector(${JSON.stringify(`${workPane} input[aria-label="网页请求输入"]`)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,'同步中文输入');node.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await js(`Array.from(document.querySelectorAll(${JSON.stringify(`${workPane} [role=dialog] button`)})).find(node=>node.textContent==='确定').click()`)
  check('product-prompt-preserves-chinese-input', (await promptValue).result === '同步中文输入')
  const cancelledDialog = controller.evaluate('s1', "confirm('取消确认')", work.tabId)
  await wait(`document.querySelector(${JSON.stringify(`${workPane} [data-browser-script-dialog]`)})!==null`)
  await js(`Array.from(document.querySelectorAll(${JSON.stringify(`${workPane} [role=dialog] button`)})).find(node=>node.textContent==='取消').click()`)
  check('product-confirm-cancel-is-false', (await cancelledDialog).result === false)
  const alertValue = controller.evaluate('s1', "alert('可继续的网页提示');'acknowledged'", work.tabId)
  await wait(`document.querySelector(${JSON.stringify(`${workPane} [data-browser-script-dialog]`)})!==null`)
  check('product-alert-only-acknowledgement', await js<number>(`document.querySelectorAll(${JSON.stringify(`${workPane} [role=dialog] button`)}).length`) === 1)
  await js(`document.querySelector(${JSON.stringify(`${workPane} [role=dialog] button`)}).click()`)
  check('product-alert-unblocks-with-acknowledgement', (await alertValue).result === 'acknowledged')
  check('product-dialog-never-shows-or-focuses-window', showEvents === dialogStartShow && focusEvents === dialogStartFocus)
  // 等待超出单次CDP预算仍保留用户选择，工具返回待回应而不重连调试器。
  const patientDialog = controller.evaluate('s1', "confirm('延时人工确认')", work.tabId).then(value => ({ value, error: null }), error => ({ value: null, error: String(error) }))
  await wait(`document.querySelector(${JSON.stringify(`${workPane} [data-browser-script-dialog]`)})!==null`)
  const patientId = controller.getState('s1')?.tabs.find(page => page.tabId === work.tabId)?.dialog?.id
  const patientResult = await patientDialog
  check('dialog-wait-survives-cdp-command-timeout', patientResult.error?.includes('网页正在等待确认') === true
    && controller.getState('s1')?.tabs.find(page => page.tabId === work.tabId)?.dialog?.id === patientId)
  await js(`Array.from(document.querySelectorAll(${JSON.stringify(`${workPane} [role=dialog] button`)})).find(node=>node.textContent==='取消').click()`)
  await wait(`document.querySelector(${JSON.stringify(`${workPane} [data-browser-script-dialog]`)})===null`)
  check('dialog-remains-actionable-after-tool-timeout', (await controller.evaluate('s1', '1+1', work.tabId)).result === 2)
  await js("dispatchEvent(new CustomEvent('smoke-options',{detail:{scale:0.9}}))")
  await delay(160)
  const scaledGeometry = await js<number[]>(`Array.from(document.querySelectorAll('[data-browser-guest-slot]')).map(slot=>{const guest=Array.from(document.querySelectorAll('webview')).find(node=>JSON.parse(node.dataset.browserGuestKey)[1]===slot.closest('[data-fixture-panel]').dataset.fixturePanel);const a=slot.getBoundingClientRect(),b=guest.getBoundingClientRect();return Math.max(Math.abs(a.left-b.left),Math.abs(a.top-b.top),Math.abs(a.width-b.width),Math.abs(a.height-b.height))})`)
  check('product-panel-transformed-host-alignment', scaledGeometry.every(error => error <= 1), scaledGeometry)
  const splitCloseHit = await js<boolean>("(()=>{const node=document.querySelector('[data-split-view-close]'),r=node.getBoundingClientRect();return !!document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('[data-split-view-close]')})()")
  check('product-split-close-above-guest', splitCloseHit)
  await js("document.querySelector('button[aria-label^=\"所有浏览器页面\"]').focus()")
  owner.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  owner.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  await wait("!!document.querySelector('[role=menu]')")
  await delay(220)
  const menuHit = await js<boolean>("(()=>{const node=document.querySelector('[role=menu]'),r=node.getBoundingClientRect();return !!document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('[role=menu]')})()")
  check('product-menu-above-guest', menuHit)
  writeFileSync(join(artifacts, 'product-panel-menu.png'), (await owner.webContents.capturePage()).toPNG())
  await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));dispatchEvent(new CustomEvent('smoke-options',{detail:{panels:false,scale:1}}))")
  await wait("!document.querySelector('[role=menu]')")
  await js(`dispatchEvent(new CustomEvent('smoke-options',{detail:{panels:true,scale:1}}));dispatchEvent(new CustomEvent('smoke-pages',{detail:${JSON.stringify([display.activeTabId, work.tabId])}}))`)
  await delay(150)
  await js(`dispatchEvent(new CustomEvent('smoke-options',{detail:{errorTab:${JSON.stringify(work.tabId)}}}))`)
  await wait(`document.querySelector('[data-fixture-panel=${JSON.stringify(work.tabId)}] [role=alert]')!==null`)
  await delay(80)
  const hiddenOnError = await js<boolean>(`getComputedStyle(Array.from(document.querySelectorAll('webview')).find(node=>JSON.parse(node.dataset.browserGuestKey)[1]===${JSON.stringify(work.tabId)})).opacity==='0'`)
  check('product-error-parks-guest', hiddenOnError)
  const errorHit = await js<boolean>(`(()=>{const node=document.querySelector('[data-fixture-panel=${JSON.stringify(work.tabId)}] [role=alert]'),r=node.getBoundingClientRect();return !!document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('[role=alert]')})()`)
  check('product-error-retry-panel-has-hit-target', errorHit)
  writeFileSync(join(artifacts, 'product-panel-error.png'), (await owner.webContents.capturePage()).toPNG())
  await js("dispatchEvent(new CustomEvent('smoke-options',{detail:{errorTab:''}}))")
  await delay(100)
  app.focus({ steal: true })
  owner.focus()
  await delay(150)
  const fixtureHasFocus = owner.isFocused()
  checks.push({ name: 'user-input-fixture-has-focus', passed: fixtureHasFocus, required: false, details: { limitation: '该隔离进程未取得系统焦点，用户分屏焦点切换不计为验收通过', ownerFocused: owner.isFocused(), guardFocused: guardWindow.isFocused() } })
  const workGuestId = await js<number>(`Array.from(document.querySelectorAll('webview')).find(node=>JSON.parse(node.dataset.browserGuestKey)[1]===${JSON.stringify(work.tabId)}).getWebContentsId()`)
  const workGuest = webContents.fromId(workGuestId)
  if (!workGuest) throw new Error('工作页 guest 未接入')
  const observedInputs: string[] = []
  workGuest.on('before-mouse-event', (_event, input) => { observedInputs.push(input.type) })
  workGuest.sendInputEvent({ type: 'mouseDown', x: 30, y: 80, button: 'left', clickCount: 1 })
  workGuest.sendInputEvent({ type: 'mouseUp', x: 30, y: 80, button: 'left', clickCount: 1 })
  await delay(100)
  check('user-guest-input-hooks-fired', observedInputs.includes('mouseDown'), { observedInputs, focused: owner.isFocused(), activeTabId: controller.getState('s1')?.activeTabId })
  if (fixtureHasFocus) {
    await wait(`document.querySelector('#fixture-focused')?.dataset.tabId===${JSON.stringify(work.tabId)}`)
    check('user-guest-input-selects-visible-pane', controller.getState('s1')?.activeTabId === work.tabId && controller.getState('s1')?.agentTabId === work.tabId)
  } else {
    check('unfocused-input-does-not-select-pane', controller.getState('s1')?.activeTabId === display.activeTabId)
  }
  controller.selectTab('s1', display.activeTabId)
  await controller.domAction('s1', { action: 'focus', selector: '#field' }, work.tabId)
  await controller.press('s1', 'Tab', work.tabId)
  check('agent-input-does-not-select-pane', controller.getState('s1')?.activeTabId === display.activeTabId)
  guardWindow.focus()
  await delay(100)
  await js("dispatchEvent(new CustomEvent('smoke-options',{detail:{panels:false}}))")
  const focusAfterUserInput = focusEvents
  await controller.closeTab('s1', display.activeTabId)
  console.log('[smoke] display tab closed')
  await controller.closeTab('s1', preview.tabId)
  console.log('[smoke] preview tab closed')
  await owner.webContents.executeJavaScript(`dispatchEvent(new CustomEvent('smoke-pages',{detail:${JSON.stringify([work.tabId])}}))`)
  console.log('[smoke] worker pane restored')
  const workerBeforeReload = (await controller.evaluate('s1', 'location.href', work.tabId)).result
  const guestIdsBeforeReload = await owner.webContents.executeJavaScript("[...document.querySelectorAll('webview')].map(node=>node.getWebContentsId())")
  const visibleBeforeReload = owner.isVisible()
  const focusedBeforeReload = owner.isFocused()
  check('renderer-reload-precondition', workerBeforeReload === `${base}/agent-next` && guestIdsBeforeReload.length === 1, { workerBeforeReload, guestIdsBeforeReload })
  console.log('[smoke] owner reload start')
  const reloadFinished = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('renderer reload did not finish in 8s')), 8_000)
    owner!.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve() })
  })
  owner.webContents.reload()
  await reloadFinished
  console.log('[smoke] owner reload finished')
  const restored = await controller.reloadDisplay('s1', work.tabId)
  console.log('[smoke] guest restore requested')
  const reloadedPage = await controller.evaluate('s1', 'location.href', work.tabId)
  console.log('[smoke] guest restore evaluated')
  const guestIdsAfterReload = await owner.webContents.executeJavaScript("[...document.querySelectorAll('webview')].map(node=>node.getWebContentsId())")
  check('renderer-reload-restores-target-url', reloadedPage.result === workerBeforeReload, { restored: restored.url, url: reloadedPage.result })
  check('renderer-reload-rebuilds-guest', JSON.stringify(guestIdsBeforeReload) !== JSON.stringify(guestIdsAfterReload), { before: guestIdsBeforeReload, after: guestIdsAfterReload })
  check('renderer-reload-preserves-window-state', owner.isVisible() === visibleBeforeReload && owner.isFocused() === focusedBeforeReload && showEvents === showBefore && focusEvents === focusAfterUserInput, { visibleBeforeReload, visibleAfter: owner.isVisible(), focusedBeforeReload, focusedAfter: owner.isFocused(), showEvents, focusEvents })
  await controller.close('s1')
  check('close-reclaims-session', controller.getState('s1') === null)
  finish()
}
process.on('uncaughtException', error => {
  console.error('[smoke] uncaught exception', error)
  finish(error)
})
process.on('unhandledRejection', error => {
  console.error('[smoke] unhandled rejection', error)
  finish(error)
})
void run().catch(finish)
