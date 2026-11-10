/** 只核验隔离Electron的系统焦点，不接触用户应用/浏览器profile。 */
import { app, BrowserWindow } from 'electron'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
app.setPath('userData', mkdtempSync(join(tmpdir(), 'profer-focus-probe-')))
const artifacts = join(__dirname, 'artifacts')
mkdirSync(artifacts, { recursive: true })
const events: unknown[] = []
let win: BrowserWindow | undefined
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const deadline = setTimeout(() => finish('timeout'), 6000)
function finish(error?: string): void {
  clearTimeout(deadline)
  const result = { pid: process.pid, version: process.versions.electron, events, visible: win?.isVisible(), focused: win?.isFocused(), appFocused: BrowserWindow.getFocusedWindow()?.id === win?.id, error }
  writeFileSync(join(artifacts, 'results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); win?.destroy(); app.exit(error ? 1 : 0)
}
void app.whenReady().then(async () => {
  if (process.platform === 'darwin') { app.setActivationPolicy('regular'); await app.dock?.show() }
  win = new BrowserWindow({ show: false, width: 420, height: 240, title: 'Profer 隔离焦点验证', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
  for (const name of ['show', 'focus', 'blur'] as const) win.on(name, () => events.push({ name, at: Date.now(), focused: win!.isFocused() }))
  await win.loadURL('data:text/html,<title>隔离测试</title><h1>仅测试窗口</h1><input>')
  win.show(); app.focus({ steal: true }); win.focus()
  await delay(750)
  events.push({ step: 'first-focus', focused: win.isFocused(), visible: win.isVisible() })
  if (!win.isFocused()) { app.focus({ steal: true }); win.moveTop(); win.focus(); await delay(750) }
  finish()
}).catch(error => finish(String(error)))
