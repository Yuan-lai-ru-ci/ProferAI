/** 独立 guest 行为探针：不加载产品 renderer、profile 或真实网站。 */
import { app, BrowserWindow, type WebContents } from 'electron'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const artifacts = join(__dirname, 'artifacts')
mkdirSync(artifacts, { recursive: true })
const userData = mkdtempSync(join(tmpdir(), 'profer-browser-guest-smoke-'))
app.setPath('userData', userData)
const results: Array<{ name: string; passed: boolean; required?: boolean; details: unknown }> = []
const guests: WebContents[] = []
let permits = 0
const guestGrants = new Map<string, { label: string; expiresAt: number }>()
const attachedTicketByGuestId = new Map<number, string>()
let rejected = 0
let attachingTicket: string | null = null
let attachingGrant: { label: string; expiresAt: number } | null = null
let attachingGuest: WebContents | null = null
let window: BrowserWindow
const partition = 'browser-guest-smoke-isolated'
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function check(name: string, passed: boolean, details: unknown = null): void {
  results.push({ name, passed, details })
  if (!passed) throw new Error(`断言失败：${name}`)
}
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(50) }
  throw new Error('等待条件超时')
}
const observedWillParams: Array<{ src: string; instanceId: string | undefined; partition: string | undefined; ticket: string | null; grantLabel: string | null; attachingTicket: string | null }> = []
const attachedGuestUrls: Array<{ id: number; urlAtDidAttach: string; hostId: number | null }> = []
const fixture = '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:rgb(20,160,80);height:100%}input{margin:45px}</style><input id="form" value="initial"><script>window.clicks=0;document.addEventListener("click",()=>window.clicks++)</script>'
const host = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:rgb(30,40,50)}#frame{position:absolute;left:100px;top:100px;width:400px;height:260px;border-radius:40px;overflow:hidden}webview{display:flex;width:400px;height:260px}#overlay{position:absolute;left:230px;top:170px;width:120px;height:70px;background:rgb(220,30,50);z-index:5}#outside{position:absolute;left:520px;top:100px;width:150px;height:100px;background:rgb(40,80,220)}#parking{position:absolute;left:100px;top:400px;visibility:hidden}
</style><div id="frame"></div><div id="parking"></div><div id="overlay"></div><div id="outside"></div><script>
window.overlayClicks=0;window.outsideClicks=0;document.querySelector('#overlay').onclick=()=>window.overlayClicks++;document.querySelector('#outside').onclick=()=>window.outsideClicks++;
window.createGuest=(id,target,ticket)=>{const v=document.createElement('webview');v.id=id;v.setAttribute('partition','${partition}');v.setAttribute('src','about:blank#profer-guest-'+ticket);document.querySelector(target).appendChild(v)};
</script>`
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(req.url === '/host' ? host : fixture) })
const deadline = setTimeout(() => finish(new Error('Electron 内部 50 秒截止')), 50_000)
let finishing = false
function finish(error?: unknown): void {
  if (finishing) return
  finishing = true
  clearTimeout(deadline)
  writeFileSync(join(artifacts, 'results.json'), JSON.stringify({ electron: process.versions.electron, platform: process.platform, userData, results, rejected, observedWillParams, attachedGuestUrls, error: error instanceof Error ? error.stack : error ?? null, limitations: ['未测 Windows、IME、真实 OAuth、下载上传与产品 controller 集成', '截图文件供视觉检查；本脚本没有做像素颜色断言', '临时 userData 保留便于排查，不使用真实 profile'] }, null, 2))
  console.log(JSON.stringify({ artifacts, results, error: error instanceof Error ? error.message : error ?? null }))
  server.close()
  app.exit(error || results.some(result => result.required !== false && !result.passed) ? 1 : 0)
}
async function run(): Promise<void> {
  await app.whenReady()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture 无监听地址')
  const base = `http://127.0.0.1:${address.port}`
  window = new BrowserWindow({ width: 800, height: 650, show: false, webPreferences: { webviewTag: true, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } })
  window.webContents.on('will-attach-webview', (event, prefs, params) => {
    const match = /^about:blank#profer-guest-([a-z0-9-]+)$/i.exec(params.src ?? '')
    const grant = match ? guestGrants.get(match[1]!) : undefined
    observedWillParams.push({ src: params.src ?? '', instanceId: params.instanceId, partition: params.partition, ticket: match?.[1] ?? null, grantLabel: grant?.label ?? null, attachingTicket })
    if (!grant || grant.expiresAt <= Date.now() || attachingTicket !== null || params.partition !== partition) { rejected++; event.preventDefault(); return }
    guestGrants.delete(match![1]!)
    attachingTicket = match![1]!
    attachingGrant = grant
    params.src = 'about:blank'
    Object.assign(prefs, { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false })
  })
  window.webContents.on('did-attach-webview', (_event, guest) => {
    const ticket = attachingTicket
    const grant = attachingGrant
    if (!ticket || !grant || guest.hostWebContents !== window.webContents || attachingGuest) {
      rejected++
      guest.close()
      return
    }
    attachingGuest = guest
    guest.setWindowOpenHandler(() => ({ action: 'deny' }))
    guest.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  })
  window.webContents.on('did-attach-webview', (_event, guest) => {
    if (attachingGuest !== guest || !attachingTicket) return
    const ticket = attachingTicket
    const grant = attachingGrant
    if (!grant || grant.expiresAt <= Date.now() || attachedTicketByGuestId.has(guest.id)) {
      rejected++
      attachingGuest = null
      attachingTicket = null
      attachingGrant = null
      guest.close()
      return
    }
    guestGrants.delete(ticket)
    attachingTicket = null
    attachingGrant = null
    attachingGuest = null
    attachedTicketByGuestId.set(guest.id, ticket)
    attachedGuestUrls.push({ id: guest.id, urlAtDidAttach: guest.getURL(), hostId: guest.hostWebContents?.id ?? null })
    guests.push(guest)
  })
  await window.loadURL(`${base}/host`)
  window.showInactive()
  const js = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>
  guestGrants.set('ticket-a', { label: 'a', expiresAt: Date.now() + 10_000 })
  await js("createGuest('a','#frame','ticket-a')")
  await waitFor(() => guests.length === 1)
  guestGrants.set('ticket-b', { label: 'b', expiresAt: Date.now() + 10_000 })
  await js("createGuest('b','#parking','ticket-b')")
  await waitFor(() => guests.length === 2)
  const [a, b] = guests
  if (!a || !b) throw new Error('缺少 guest')
  await Promise.all([a.loadURL(`${base}/fixture-a`), b.loadURL(`${base}/fixture-b`)])
  check('two-distinct-guests', a.id !== b.id, { a: a.id, b: b.id })
  check('ticket-binds-exact-guest-concurrently', attachedTicketByGuestId.get(a.id) === 'ticket-a' && attachedTicketByGuestId.get(b.id) === 'ticket-b' && a.hostWebContents === window.webContents && b.hostWebContents === window.webContents, { a: attachedTicketByGuestId.get(a.id), b: attachedTicketByGuestId.get(b.id), attachedGuestUrls })
  const security = await a.executeJavaScript('({node:typeof require,process:typeof process})')
  check('guest-no-node', security.node === 'undefined' && security.process === 'undefined', security)
  await a.executeJavaScript("document.querySelector('#form').value='retained'")
  const originalId = a.id
  await js("document.querySelector('#frame').style.visibility='hidden'")
  a.debugger.attach('1.3')
  const cdp = await a.debugger.sendCommand('Runtime.evaluate', { expression: "document.querySelector('#form').value += '-background';document.querySelector('#form').value", returnByValue: true })
  check('background-cdp', cdp.result.value === 'retained-background', cdp.result)
  const screenshot: { data?: string } = await Promise.race([
    a.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }),
    delay(3000).then(() => ({})),
  ])
  if (screenshot.data) writeFileSync(join(artifacts, 'background-cdp.png'), Buffer.from(screenshot.data, 'base64'))
  results.push({ name: 'visibility-hidden-cdp-probe', required: false, passed: Boolean(screenshot.data), details: screenshot.data ? { base64Length: screenshot.data.length } : 'CSS visibility:hidden 下 CDP screenshot 3秒未返回；不支持的对照模式，不能用于产品后台截图' })
  await js("document.querySelector('#frame').style.visibility='visible'")
  check('hide-restore-same-id-form', await js("document.querySelector('#a').getWebContentsId()") === originalId && await a.executeJavaScript("document.querySelector('#form').value") === 'retained-background')
  await delay(200)
  // 截图不应该要求用户看见页面：逐种验证公共 API 与 CSS 停放方式，失败留证而非跳过。
  for (const mode of ['hidden-native', 'opacity-native', 'opacity-cdp', 'clipped-native'] as const) {
    await js(mode === 'hidden-native'
      ? "document.querySelector('#frame').style.cssText='visibility:hidden'"
      : mode === 'clipped-native'
        ? "document.querySelector('#frame').style.cssText='clip-path:inset(50%);pointer-events:none'"
        : "document.querySelector('#frame').style.cssText='opacity:0;pointer-events:none'")
    await delay(100)
    let bytes: Buffer | null = null
    try {
      bytes = await Promise.race([
        mode === 'opacity-cdp'
          ? a.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }).then(result => Buffer.from(result.data, 'base64'))
          : a.capturePage(undefined, { stayHidden: true }).then(image => image.isEmpty() ? null : image.toPNG()),
        delay(2000).then(() => null),
      ])
    } catch { /* 模式不支持时记录失败，继续其他独立探针。 */ }
    if (bytes) writeFileSync(join(artifacts, `${mode}.png`), bytes)
    results.push({ name: `capture-${mode}`, required: mode === 'opacity-native', passed: !!bytes?.length, details: { bytes: bytes?.length ?? 0 } })
    await js("document.querySelector('#frame').style.cssText=''")
    await delay(150)
  }
  // 最终候选必须拿到新帧，而非隐藏前的缓存纹理。
  await js("document.querySelector('#frame').style.cssText='opacity:0;pointer-events:none';document.querySelector('#frame').inert=true")
  await a.debugger.sendCommand('Runtime.evaluate', { expression: "document.body.style.background='rgb(30,100,220)';document.querySelector('#form').value='fresh-hidden-frame'", returnByValue: true })
  const fresh = await Promise.race([a.capturePage(undefined, { stayHidden: true }), delay(3000).then(() => null)])
  if (!fresh || fresh.isEmpty()) throw new Error('透明停放未获得新帧')
  const sample = fresh.crop({ x: 350, y: 200, width: 1, height: 1 }).toBitmap()
  check('opacity-native-fresh-frame', Math.abs((sample[0] ?? 0) - 220) <= 2 && Math.abs((sample[1] ?? 0) - 100) <= 2 && Math.abs((sample[2] ?? 0) - 30) <= 2, { pixelBGRA: [...sample], tolerance: 2 })
  writeFileSync(join(artifacts, 'opacity-fresh.png'), fresh.toPNG())
  const beforeHiddenId = a.id
  window.hide()
  const hiddenCapture = await Promise.race([a.capturePage(undefined, { stayHidden: true }), delay(3000).then(() => null)])
  check('hidden-owner-native-capture', !!hiddenCapture && !hiddenCapture.isEmpty() && !window.isVisible() && a.id === beforeHiddenId)
  if (hiddenCapture) writeFileSync(join(artifacts, 'hidden-owner-native.png'), hiddenCapture.toPNG())
  window.showInactive()
  await a.executeJavaScript("document.body.style.background='rgb(20,160,80)'")
  await js("document.querySelector('#frame').style.cssText='';document.querySelector('#frame').inert=false")
  await delay(400)
  writeFileSync(join(artifacts, 'host-overlay-corner.png'), (await window.webContents.capturePage()).toPNG())
  async function click(x: number, y: number): Promise<void> {
    window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await delay(100)
  }
  await click(260, 190)
  await click(550, 130)
  check('overlay-outside-native-input', await js('overlayClicks===1 && outsideClicks===1'), await js('({overlayClicks,outsideClicks})'))
  check('overlay-does-not-click-guest', await a.executeJavaScript('window.clicks') === 0)
  guestGrants.set('ticket-unauthorized', { label: 'unauthorized', expiresAt: Date.now() + 10_000 })
  await js("createGuest('unauthorized','#parking','ticket-missing')")
  await waitFor(() => rejected === 1)
  check('unpermitted-attach-denied', guests.length === 2 && rejected === 1)
  await js("document.querySelector('#a').remove()")
  await waitFor(() => a.isDestroyed())
  check('remove-destroys-guest', a.isDestroyed())
  guestGrants.set('ticket-a2', { label: 'a2', expiresAt: Date.now() + 10_000 })
  await js("createGuest('a2','#frame','ticket-a2')")
  await waitFor(() => guests.length === 3)
  const replacement = guests[2]
  if (!replacement) throw new Error('缺少替代 guest')
  await replacement.loadURL(`${base}/fixture-new`)
  check('replacement-new-id-fresh-form', replacement.id !== originalId && await replacement.executeJavaScript("document.querySelector('#form').value") === 'initial', { id: replacement.id })
  window.webContents.reload()
  await waitFor(() => b.isDestroyed() && replacement.isDestroyed())
  check('host-reload-destroys-guests', b.isDestroyed() && replacement.isDestroyed())
  await waitFor(() => !window.webContents.isLoading())
  guestGrants.set('ticket-after-reload', { label: 'afterReload', expiresAt: Date.now() + 10_000 })
  await js("createGuest('afterReload','#frame','ticket-after-reload')")
  await waitFor(() => guests.length === 4)
  const afterReload = guests[3]
  if (!afterReload) throw new Error('reload 后 guest 缺失')
  await afterReload.loadURL(`${base}/fixture-reload`)
  check('reload-explicit-recreation', afterReload.id !== replacement.id, { id: afterReload.id })
  finish()
}
void run().catch(finish)
