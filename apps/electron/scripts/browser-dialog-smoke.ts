/** 只对隔离本地 fixture 验证脚本对话框，不读取用户 profile。 */
import { app, BrowserWindow, type WebContents } from 'electron'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

app.setPath('userData', mkdtempSync(join(tmpdir(), 'profer-dialog-smoke-')))
const events: Array<Record<string, unknown>> = []
const artifacts = join(__dirname, 'artifacts')
mkdirSync(artifacts, { recursive: true })
let win: BrowserWindow | undefined
let guest: WebContents | undefined
let completed = false
let focus = 0
let show = 0
function finish(error?: unknown): void {
  if (completed) return
  completed = true
  writeFileSync(join(artifacts, 'results.json'), JSON.stringify({ events, focus, show, electron: process.versions.electron, error: error instanceof Error ? error.stack : error ?? null }, null, 2))
  console.log(JSON.stringify({ events, focus, show, error: error instanceof Error ? error.message : error ?? null }))
  win?.destroy()
  app.exit(error ? 1 : 0)
}
const deadline = setTimeout(() => finish(new Error('dialog probe timeout')), 15_000)
async function run(): Promise<void> {
  await app.whenReady()
  win = new BrowserWindow({ show: false, width: 700, height: 500, webPreferences: { webviewTag: true, nodeIntegration: false, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  win.on('focus', () => { focus++ }); win.on('show', () => { show++ })
  win.webContents.on('will-attach-webview', (_event, preferences) => {
    delete preferences.preload
    Object.assign(preferences, { nodeIntegration: false, sandbox: true, contextIsolation: true, webSecurity: true, webviewTag: false, disableDialogs: true })
  })
  const attached = new Promise<WebContents>(resolve => win!.webContents.once('did-attach-webview', (_event, contents) => {
    contents.once('dom-ready', () => resolve(contents))
  }))
  await win.loadURL('data:text/html,<webview src="about:blank" style="width:640px;height:400px"></webview>')
  guest = await attached
  guest.debugger.attach('1.3')
  guest.debugger.on('message', (_event, method, params: Record<string, unknown>) => {
    if (method !== 'Page.javascriptDialogOpening') return
    events.push({ method, ...params })
    console.log('[dialog-probe]', JSON.stringify(params))
    setTimeout(() => {
      const accept = true
      void guest!.debugger.sendCommand('Page.handleJavaScriptDialog', { accept, ...(params.type === 'prompt' ? { promptText: '本机输入' } : {}) }).catch(finish)
    }, 1200)
  })
  await guest.debugger.sendCommand('Page.enable')
  const started = Date.now()
  const result = await guest.debugger.sendCommand('Runtime.evaluate', { expression: "(()=>{alert('后台alert');const confirmed=confirm('后台confirm');let promptError='';try{prompt('后台prompt','默认')}catch(e){promptError=e.message}return {confirmed,promptError}})()", returnByValue: true })
  events.push({ elapsed: Date.now() - started, result })
  const value = result.result?.value
  if (value?.confirmed !== true || Date.now() - started < 2000 || value?.promptError !== 'prompt() is not supported.' || events.filter(event => event.method === 'Page.javascriptDialogOpening').length !== 2) throw new Error('脚本未等待延迟接受：不能通过自动取消代替对话框')
  if (focus !== 0 || show !== 0 || win.isVisible()) throw new Error('脚本对话框唤起了隐藏窗口')
  clearTimeout(deadline)
  finish()
}
process.on('uncaughtException', finish)
process.on('unhandledRejection', finish)
void run().catch(finish)
