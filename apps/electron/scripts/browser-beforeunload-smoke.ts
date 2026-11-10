import { app, BrowserWindow, type WebContents } from 'electron'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

app.setPath('userData', mkdtempSync(join(tmpdir(), 'profer-beforeunload-smoke-')))
const artifacts = join(__dirname, 'artifacts')
mkdirSync(artifacts, { recursive: true })
const observations: Array<Record<string, unknown>> = []
const html = (path: string) => `<!doctype html><title>${path}</title><script>window.addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = 'fixture warning' })</script><a href="/next">next</a>`
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.end(html(request.url ?? '/'))
})
let windowRef: BrowserWindow | undefined
let guest: WebContents | undefined
let finishing = false

function finish(error?: unknown): void {
  if (finishing) return
  finishing = true
  clearTimeout(hardDeadline)
  try {
    writeFileSync(join(artifacts, 'results.json'), JSON.stringify({ electron: process.versions.electron, platform: process.platform, observations, error: error instanceof Error ? error.stack : error ?? null }, null, 2))
    console.log(JSON.stringify({ electron: process.versions.electron, observations, error: error instanceof Error ? error.message : error ?? null }))
  } finally {
    try { guest?.debugger.detach() } catch {}
    try { windowRef?.destroy() } catch {}
    server.close()
    app.exit(error ? 1 : 0)
  }
}
const hardDeadline = setTimeout(() => finish(new Error('probe hard deadline exceeded')), 18_000)

async function run(): Promise<void> {
  await app.whenReady()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture listener unavailable')
  const url = `http://127.0.0.1:${address.port}/`
  windowRef = new BrowserWindow({ show: false, width: 680, height: 440, webPreferences: { nodeIntegration: false, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  guest = windowRef.webContents
  guest.debugger.attach('1.3')
  let currentAction = 'initial'
  let dialogCount = 0
  guest.on('will-prevent-unload', event => {
    observations.push({ action: currentAction, event: 'will-prevent-unload', visible: windowRef!.isVisible(), defaultPreventedInitially: event.defaultPrevented })
  })
  guest.debugger.on('message', (_event, method, params: Record<string, unknown>) => {
    if (method !== 'Page.javascriptDialogOpening') return
    dialogCount++
    observations.push({ action: currentAction, event: method, params, visible: windowRef!.isVisible() })
    void guest!.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: false }).catch(error => observations.push({ action: currentAction, event: 'dialog-dismiss-error', error: String(error) }))
  })
  await guest.debugger.sendCommand('Page.enable')
  observations.push({ action: 'Page.enable', event: 'enabled', visible: windowRef.isVisible(), electron: process.versions.electron })
  await guest.loadURL(url)
  await guest.loadURL(`${url}next`)
  const attempt = async (name: string, action: () => Promise<unknown>): Promise<void> => {
    currentAction = name
    const start = Date.now()
    try { await action() } catch (error) { observations.push({ action: name, event: 'action-error', error: String(error) }) }
    await new Promise(resolve => setTimeout(resolve, 350))
    observations.push({ action: name, event: 'settled', elapsedMs: Date.now() - start, url: guest!.getURL(), visible: windowRef!.isVisible(), dialogCount })
  }
  await attempt('hidden-location-navigation', () => guest!.executeJavaScript("location.href='/next'"))
  await attempt('hidden-reload', () => guest!.reload())
  windowRef.show()
  observations.push({ action: 'owner-show', event: 'visibility-check', visible: windowRef.isVisible() })
  await attempt('visible-location-navigation', () => guest!.executeJavaScript("document.querySelector('a').click()"))
  windowRef.hide()
  observations.push({ action: 'owner-hide', event: 'visibility-check', visible: windowRef.isVisible() })
  observations.push({ action: 'limitations', close: 'not attempted: closing the isolated top-level window risks native modal; no trusted system-input focus was established', programmaticNavigation: 'observed no dialogs in this run' })
  finish()
}
process.on('uncaughtException', finish)
process.on('unhandledRejection', finish)
void run().catch(finish)
