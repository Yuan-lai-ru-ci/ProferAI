/** 受限同步协议探针：只返回对话框结果，不使用 guest preload/Node 或远程页面。 */
import { app, BrowserWindow, protocol, session, type WebContents } from 'electron'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserDialogProtocol, BROWSER_DIALOG_SCHEME } from '../src/main/lib/browser-dialog-protocol'
import { BrowserPageInteractions } from '../src/main/lib/browser-page-interactions'
import { BrowserDialogFrameScripts } from '../src/main/lib/browser-dialog-frame-scripts'

app.commandLine.appendSwitch('site-per-process')

protocol.registerSchemesAsPrivileged([{ scheme: BROWSER_DIALOG_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }])
app.setPath('userData', mkdtempSync(join(tmpdir(), 'profer-dialog-protocol-smoke-')))
const artifacts = join(__dirname, 'artifacts')
mkdirSync(artifacts, { recursive: true })
const requests: Array<Record<string, unknown>> = []
let interactions: BrowserPageInteractions | undefined
let win: BrowserWindow | undefined, guest: WebContents | undefined
let show = 0, focus = 0, done = false
const crossOriginServer = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end('<!doctype html><h1>跨源子框架</h1><script>globalThis.earlyDialogResult=confirm("跨站首屏脚本确认")</script>')
})
let crossOriginPort = 0
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'none'; frame-src * about:; script-src 'self'")
  res.end(req.url === '/' ? `<!doctype html><h1>严格CSP</h1><iframe src="about:blank"></iframe><iframe src="/child"></iframe><iframe src="http://localhost:${crossOriginPort}/"></iframe>` : '<!doctype html><h1>子框架</h1>')
})
function finish(error?: unknown): void {
  if (done) return
  done = true
  clearTimeout(deadline)
  writeFileSync(join(artifacts, 'results.json'), JSON.stringify({ requests, show, focus, error: error instanceof Error ? error.stack : error ?? null }, null, 2))
  console.log(JSON.stringify({ requests, show, focus, error: error instanceof Error ? error.message : error ?? null }))
  interactions?.dispose()
  win?.destroy()
  crossOriginServer.close(); server.close(); app.exit(error ? 1 : 0)
}
const deadline = setTimeout(() => finish(new Error('protocol probe timeout')), 15_000)
async function run(): Promise<void> {
  await app.whenReady()
  const isolated = session.fromPartition('dialog-protocol-smoke')
  const frameRequests: Array<Record<string, unknown>> = []
  const dialogProtocol = new BrowserDialogProtocol(isolated)
  isolated.webRequest.onBeforeRequest((details, callback) => {
    if (details.url.startsWith(`${BROWSER_DIALOG_SCHEME}:`)) {
      frameRequests.push({ webContentsId: details.webContentsId, frameRoutingId: details.frame?.routingId, frameUrl: details.frame?.url, resourceType: details.resourceType })
      callback({ cancel: !dialogProtocol.authorize(details) })
    } else callback({ cancel: false })
  })
  win = new BrowserWindow({ show: false, width: 800, height: 550, webPreferences: { webviewTag: true, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } })
  win.on('show', () => { show++ }); win.on('focus', () => { focus++ })
  const attached = new Promise<WebContents>(resolve => win!.webContents.once('did-attach-webview', (_event, contents) => contents.once('dom-ready', () => resolve(contents))))
  await win.loadURL('data:text/html,<webview src="about:blank" partition="dialog-protocol-smoke" style="width:700px;height:450px"></webview>')
  guest = await attached
  guest.debugger.attach('1.3')
  const executionContexts: Array<{ id?: number; origin?: string; name?: string; auxData?: Record<string, unknown>; sessionId?: string }> = []
  const iframeSessions = new Set<string>()
  guest.debugger.on('message', (_event, method, params, sessionId) => {
    if (method === 'Runtime.executionContextCreated') executionContexts.push({ ...(params as { context: typeof executionContexts[number] }).context, sessionId })
    if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe') {
      iframeSessions.add(params.sessionId)
      void guest!.debugger.sendCommand('Runtime.enable', {}, params.sessionId)
    }
  })
  await guest.debugger.sendCommand('Runtime.enable')
  await guest.debugger.sendCommand('Page.enable')
  interactions = new BrowserPageInteractions(guest, () => {
    const dialog = interactions?.snapshot().dialog
    if (dialog) {
      requests.push({ type: dialog.type, origin: dialog.origin })
      // fixture 的定时回应只验证同步协议；产品UI回应另由controller smoke覆盖。
      setTimeout(() => { void interactions?.respond({ dialogId: dialog.id, accept: true, promptText: '协议中文' }) }, 600)
    }
  })
  const endpoint = dialogProtocol.register({ contents: guest, current: () => true, request: (input, alive, signal) => interactions!.requestDialog(input, alive, signal) })
  const frameScripts = new BrowserDialogFrameScripts(guest.debugger, endpoint.source, finish)
  await frameScripts.start()
  await new Promise<void>(resolve => crossOriginServer.listen(0, resolve))
  const crossOriginAddress = crossOriginServer.address()
  if (!crossOriginAddress || typeof crossOriginAddress === 'string') throw new Error('跨源 fixture 未监听')
  crossOriginPort = crossOriginAddress.port
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture未启动')
  await guest.loadURL(`http://127.0.0.1:${address.port}/`)
  const tree = await guest.debugger.sendCommand('Page.getFrameTree')
  const frameIds: string[] = []
  const collectFrames = (node: { frame?: { id?: string }; childFrames?: unknown[] }): void => {
    if (typeof node.frame?.id === 'string') frameIds.push(node.frame.id)
    for (const child of node.childFrames ?? []) collectFrames(child as typeof node)
  }
  collectFrames(tree.frameTree)
  const children = executionContexts.filter(context => context.auxData?.type === 'default' && context.auxData?.frameId !== frameIds[0])
  if (children.length !== 3 || iframeSessions.size !== 1) throw new Error(`OOPIF context数不符: sessions=${iframeSessions.size}, contexts=${JSON.stringify(executionContexts)}`)
  const started = Date.now()
  const results = []
  for (const context of children) {
    const params = { contextId: context.id, expression: "(()=>{const yes=confirm('子框架确认');return {yes,url:location.href,node:typeof globalThis['process'],require:typeof globalThis['require']}})()", returnByValue: true }
    results.push(await (context.sessionId ? guest.debugger.sendCommand('Runtime.evaluate', params, context.sessionId) : guest.debugger.sendCommand('Runtime.evaluate', params)))
  }
  requests.push({ elapsed: Date.now() - started, iframeSessions: [...iframeSessions], frameIds, executionContexts, frameRequests, childResults: results })
  if (results.some(result => result.result?.value?.yes !== true || result.result?.value?.node !== 'undefined' || result.result?.value?.require !== 'undefined')) throw new Error('跨框架同步对话框/CSP结果不符')
  const crossSiteContext = children.find(context => context.sessionId)
  if (!crossSiteContext) throw new Error('未建立独立iframe CDP session')
  const early = await guest.debugger.sendCommand('Runtime.evaluate', { contextId: crossSiteContext.id, expression: 'globalThis.earlyDialogResult', returnByValue: true }, crossSiteContext.sessionId)
  if (early.result?.value !== true) throw new Error('跨站首屏脚本未被保护')
  requests.push({ earlyCrossSiteDialog: early.result.value })
  // 模拟CDP重连，再建立新文档；旧target的document-start hook不能当成仍然存在。
  guest.debugger.detach()
  guest.debugger.attach('1.3')
  await frameScripts.start()
  await guest.loadURL(`http://127.0.0.1:${address.port}/reconnected`)
  const reconnected = await guest.debugger.sendCommand('Runtime.evaluate', { expression: "prompt('重连后输入','默认')", returnByValue: true })
  if (reconnected.result?.value !== '协议中文') throw new Error('重连后新文档没有恢复同步提示')
  requests.push({ reconnectPrompt: reconnected.result.value })
  if (show || focus || win.isVisible()) throw new Error('协议对话框唤起了隐藏窗口')
  frameScripts.dispose()
  endpoint.dispose()
  finish()
}
process.on('uncaughtException', finish); process.on('unhandledRejection', finish)
void run().catch(finish)
