import { app, BrowserWindow, ipcMain, session, type WebContents } from 'electron'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

app.setPath('userData', mkdtempSync(join(tmpdir(), 'profer-dialog-bridge-smoke-')))
const artifacts = join(__dirname, 'artifacts')
mkdirSync(artifacts, { recursive: true })
const dialogs: Array<Record<string, unknown>> = []
let win: BrowserWindow | undefined
let guest: WebContents | undefined
let done = false
let show = 0, focus = 0
function finish(error?: unknown): void {
  if (done) return
  done = true
  writeFileSync(join(artifacts, 'results.json'), JSON.stringify({ dialogs, show, focus, electron: process.versions.electron, error: error instanceof Error ? error.stack : error ?? null }, null, 2))
  console.log(JSON.stringify({ dialogs, show, focus, error: error instanceof Error ? error.message : error ?? null }))
  win?.destroy(); app.exit(error ? 1 : 0)
}
const deadline = setTimeout(() => finish(new Error('bridge dialog probe timeout')), 15_000)
async function run(): Promise<void> {
  await app.whenReady()
  const partition = 'dialog-bridge-smoke'
  const isolated = session.fromPartition(partition)
  // 与 session preload 区分：验证固定 WebPreferences preload 对 iframe 的公开行为。
  // isolated.registerPreloadScript(...) 不覆盖 about:blank 子框架。
  win = new BrowserWindow({ show: false, width: 700, height: 500, webPreferences: { webviewTag: true, nodeIntegration: false, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  win.on('show', () => { show++ }); win.on('focus', () => { focus++ })
  win.webContents.on('will-attach-webview', (_event, preferences) => {
    preferences.preload = join(__dirname, 'guest.cjs')
    Object.assign(preferences, { nodeIntegration: false, nodeIntegrationInSubFrames: true, sandbox: true, contextIsolation: true, webSecurity: true, webviewTag: false })
  })
  const attached = new Promise<WebContents>(resolve => win!.webContents.once('did-attach-webview', (_event, contents) => {
    console.log('[bridge-probe] attached', contents.id)
    contents.on('console-message', (_event, level, message) => console.log('[guest-console]', level, message))
    contents.on('preload-error', (_event, path, error) => console.error('[guest-preload]', path, error))
    contents.once('dom-ready', () => { console.log('[bridge-probe] guest ready'); resolve(contents) })
  }))
  ipcMain.on('smoke:guest-dialog', (event, raw: Record<string, unknown>) => {
    console.log('[bridge-probe] request received', raw.type, event.sender.id)
    if (event.sender !== guest || !event.senderFrame) { event.returnValue = null; return }
    dialogs.push({ ...raw, origin: event.senderFrame.url })
    setTimeout(() => { event.returnValue = raw.type === 'confirm' ? true : raw.type === 'prompt' ? '同步中文输入' : null }, 700)
  })
  await win.loadURL(`data:text/html,<webview partition="${partition}" src="about:blank" style="width:640px;height:400px"></webview>`)
  guest = await attached
  guest.debugger.attach('1.3')
  await guest.debugger.sendCommand('Page.enable')
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><iframe src="about:blank"></iframe><iframe src="/child"></iframe>') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture未启动')
  await guest.loadURL(`http://127.0.0.1:${address.port}/`)
  const start = Date.now()
  const env = await guest.debugger.sendCommand('Runtime.evaluate', { expression: "({alert:String(alert),confirm:String(confirm),prompt:String(prompt)})", returnByValue: true })
  console.log('[bridge-probe] env', JSON.stringify(env))
  const result = await guest.debugger.sendCommand('Runtime.evaluate', { expression: "(()=>{alert('等待alert');const accepted=confirm('等待confirm');const text=prompt('等待prompt','默认');const childText=frames[0].prompt('iframeprompt','child');const childNode=frames[0].eval('typeof process+\":\"+typeof require');return {accepted,text,childText,childNode,node:typeof globalThis['process'],ipc:typeof globalThis['ipcRenderer']}})()", returnByValue: true })
  const value = result.result?.value
  dialogs.push({ elapsed: Date.now() - start, value, exception: result.exceptionDetails })
  if (value?.accepted !== true || value?.text !== '同步中文输入' || value?.childText !== '同步中文输入' || value?.childNode !== 'undefined:undefined' || value?.node !== 'undefined' || value?.ipc !== 'undefined' || Date.now() - start < 2000) throw new Error('同步对话框或沙箱/子框架结果不符')
  if (show || focus || win.isVisible()) throw new Error('对话框唤起隐藏主窗口')
  server.close()
  clearTimeout(deadline); finish()
}
process.on('uncaughtException', finish); process.on('unhandledRejection', finish)
void run().catch(finish)
