import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { constants } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { assertSafeBrowserDestination, assertSafeBrowserSubresourceDestination } from '../../../packages/agent-runtime/src/browser-policy.ts'
import { withBrowserCdpTimeout } from '../../../packages/agent-runtime/src/browser-cdp.ts'

export interface CoreBrowserConnection {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>
  onEvent(handler: (method: string, params: Record<string, unknown>, sessionId?: string) => void): () => void
  close(): Promise<void>
}
export interface CoreBrowserHostOptions {
  /** 必须指向所属 Core 上已经部署的 Chromium；不搜索、不下载、不连接桌面。 */
  executablePath?: string
  factory?: () => Promise<CoreBrowserConnection>
  /** 每次读取（包括 HTML 相对资源）都须执行 Core 会话路径授权。 */
  readAuthorizedFile?: (path: string, maxBytes: number, signal?: AbortSignal) => Promise<{ name: string; bytes: Uint8Array }>
  /** 非 HTML 文件必须交给正式预览宿主，尤其不得私建 PPTX 渲染器。 */
  openFilePreview?: (path: string, signal?: AbortSignal) => Promise<unknown>
}

/** Chromium 的本机匿名 pipe，不暴露远程调试 TCP 端口。 */
async function launchBrowser(executablePath: string | undefined): Promise<CoreBrowserConnection> {
  if (!executablePath || !isAbsolute(executablePath)) throw new Error('Core 浏览器不可用：请显式配置本机 Chromium 绝对路径。')
  await access(executablePath, constants.X_OK)
  const profile = await mkdtemp(join(tmpdir(), 'profer-core-browser-'))
  const child: ChildProcess = spawn(executablePath, [`--user-data-dir=${profile}`, '--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true })
  const input = child.stdio[3] as Writable
  const output = child.stdio[4] as Readable
  let next = 0
  let buffer = ''
  let closed = false
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const listeners = new Set<(method: string, params: Record<string, unknown>, sessionId?: string) => void>()
  const fail = (error: Error): void => { closed = true; for (const item of pending.values()) item.reject(error); pending.clear() }
  child.on('error', fail)
  child.on('exit', () => { fail(new Error('Core 浏览器进程已退出。')); void rm(profile, { recursive: true, force: true }).catch(() => undefined) })
  output.setEncoding('utf8')
  output.on('data', (chunk: string) => {
    buffer += chunk
    let boundary: number
    while ((boundary = buffer.indexOf('\0')) >= 0) {
      const raw = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1)
      try {
        const message = JSON.parse(raw) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string }
        if (message.id !== undefined) {
          const item = pending.get(message.id); pending.delete(message.id)
          if (message.error) item?.reject(new Error(message.error.message)); else item?.resolve(message.result)
        } else if (message.method) for (const listener of listeners) listener(message.method, message.params ?? {}, message.sessionId)
      } catch { fail(new Error('Core 浏览器返回无效 CDP 消息。')); child.kill() }
    }
  })
  return {
    async send<T>(method: string, params = {}, sessionId?: string): Promise<T> {
      if (closed) throw new Error('Core 浏览器连接已关闭。')
      const id = ++next
      try {
        return await withBrowserCdpTimeout(() => new Promise<T>((resolve, reject) => {
          pending.set(id, { resolve: value => resolve(value as T), reject })
          input.write(JSON.stringify({ id, method, params, sessionId }) + '\0', error => { if (error) { pending.delete(id); reject(error) } })
        }), method)
      } finally { pending.delete(id) }
    },
    onEvent(handler) { listeners.add(handler); return () => listeners.delete(handler) },
    async close() { fail(new Error('Core 浏览器已关闭。')); listeners.clear(); child.kill() },
  }
}

export interface CoreBrowserTab { id: string; targetId: string; browserContextId: string; cdpSessionId: string; revision: number }

/** 一个实例只属于一个 Agent 会话；调用方应在会话释放时 dispose。 */
export class CoreBrowserHost {
  private connection?: Promise<CoreBrowserConnection>
  private tabs = new Map<string, CoreBrowserTab>()
  private active?: string
  private previews = new Map<string, { origin: string; path: string; name: string }>()
  private disposed = false
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly options: CoreBrowserHostOptions = {}) {}
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => undefined)
    return result
  }
  private connect(): Promise<CoreBrowserConnection> {
    if (this.disposed) throw new Error('Core 浏览器已释放。')
    if (!this.connection) this.connection = (this.options.factory?.() ?? launchBrowser(this.options.executablePath)).then(connection => {
      connection.onEvent((method, params, sessionId) => {
        if (method === 'Page.frameNavigated') {
          const frame = params.frame as { parentId?: string; url?: string } | undefined
          if (!frame?.parentId) for (const tab of this.tabs.values()) if (tab.cdpSessionId === sessionId) {
            tab.revision++
            const preview = this.previews.get(tab.cdpSessionId)
            if (preview && frame?.url && !frame.url.startsWith(preview.origin + '/')) this.previews.delete(tab.cdpSessionId)
          }
        }
        if (method === 'Fetch.requestPaused') void this.handleRequest(connection, params, sessionId).catch(() => connection.close())
        if (method === 'Page.javascriptDialogOpening') void connection.send('Page.handleJavaScriptDialog', { accept: false }, sessionId).catch(() => undefined)
      })
      return connection
    }).catch(error => { this.connection = undefined; throw error })
    return this.connection
  }
  private async handleRequest(connection: CoreBrowserConnection, params: Record<string, unknown>, sessionId?: string): Promise<void> {
    const request = params.request as { url: string }
    try {
      const preview = sessionId ? this.previews.get(sessionId) : undefined
      if (preview && new URL(request.url).origin === preview.origin) {
        if ((params.request as { method?: string }).method !== 'GET') throw new Error('本地预览仅支持只读 GET。')
        const url = new URL(request.url)
        const resource = decodeURIComponent(url.pathname)
        if (resource.includes(String.fromCharCode(0)) || resource.includes(String.fromCharCode(92))) throw new Error('预览资源路径无效。')
        const path = resource === '/index.html' ? preview.path : resolve(dirname(preview.path), '.' + resource)
        const file = await this.options.readAuthorizedFile!(path, 16 * 1024 * 1024)
        if (file.bytes.byteLength > 16 * 1024 * 1024) throw new Error('预览资源过大。')
        const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff': 'font/woff', '.woff2': 'font/woff2' }
        await connection.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: mime[extname(path).toLowerCase()] ?? 'application/octet-stream' }, { name: 'X-Content-Type-Options', value: 'nosniff' }], body: Buffer.from(file.bytes).toString('base64') }, sessionId)
        return
      }
      if (params.resourceType === 'Document') await assertSafeBrowserDestination(request.url)
      else {
        const result = await connection.send<{ result: { value?: string } }>('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId)
        await assertSafeBrowserSubresourceDestination(request.url, result.result.value)
      }
      await connection.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId)
    } catch { await connection.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, sessionId) }
  }
  async previewOpen(path: string, tabId?: string, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new Error('预览已取消。')
    const extension = extname(path).toLowerCase()
    if (extension && extension !== '.html' && extension !== '.htm') {
      if (!this.options.openFilePreview) throw new Error('正式文件预览宿主未连接。')
      return this.options.openFilePreview(path, signal)
    }
    if (!this.options.readAuthorizedFile) throw new Error('未装配 Core 授权文件读取器。')
    const filePath = extension ? path : join(path, 'index.html')
    const file = await this.options.readAuthorizedFile(filePath, 16 * 1024 * 1024, signal)
    if (file.bytes.byteLength > 16 * 1024 * 1024) throw new Error('HTML 预览超过 16 MiB。')
    const tab = tabId ? await this.tab(tabId) : await this.newTab()
    const origin = `https://${randomUUID()}.profer-preview.invalid`
    this.previews.set(tab.cdpSessionId, { origin, path: filePath, name: basename(file.name) })
    tab.revision++
    const result = await this.send<{ errorText?: string }>(tab, 'Page.navigate', { url: `${origin}/index.html` })
    if (result.errorText) throw new Error(result.errorText)
    return { tabId: tab.id, url: `${origin}/index.html`, localFile: { name: basename(file.name), readOnly: true } }
  }
  async newTab(url?: string): Promise<CoreBrowserTab> {
    const safe = url ? await assertSafeBrowserDestination(url) : undefined
    const connection = await this.connect()
    const { browserContextId } = await connection.send<{ browserContextId: string }>('Target.createBrowserContext', { disposeOnDetach: true })
    await connection.send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId })
    const { targetId } = await connection.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId })
    const { sessionId } = await connection.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    const tab = { id: randomUUID(), targetId, browserContextId, cdpSessionId: sessionId, revision: 0 }
    this.tabs.set(tab.id, tab); this.active = tab.id
    await connection.send('Page.enable', {}, sessionId)
    await connection.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId)
    if (safe) await this.navigate(tab, safe)
    return tab
  }
  async tab(id?: string): Promise<CoreBrowserTab> {
    const tab = this.tabs.get(id ?? this.active ?? '')
    if (tab) return tab
    if (id) throw new Error('Core 浏览器标签不存在或不属于当前会话。')
    return this.newTab()
  }
  async send<T = Record<string, unknown>>(tab: CoreBrowserTab, method: string, params: Record<string, unknown> = {}): Promise<T> {
    return withBrowserCdpTimeout(() => this.connect().then(connection => connection.send<T>(method, params, tab.cdpSessionId)), method)
  }
  async evaluate<T>(tab: CoreBrowserTab, expression: string): Promise<T> {
    const result = await this.send<{ result: { value: T }; exceptionDetails?: unknown }>(tab, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error('Core 浏览器页面脚本执行失败。')
    const value = result.result.value
    if ((JSON.stringify(value)?.length ?? 0) > 256 * 1024) throw new Error('浏览器脚本结果超过 256 KiB，请缩小查询范围。')
    return value
  }
  async navigate(tab: CoreBrowserTab, url: string): Promise<unknown> {
    const safe = await assertSafeBrowserDestination(url)
    this.previews.delete(tab.cdpSessionId)
    tab.revision++
    const result = await this.send<{ errorText?: string }>(tab, 'Page.navigate', { url: safe })
    if (result.errorText) throw new Error(result.errorText)
    return result
  }
  localFile(tab: CoreBrowserTab): { name: string; readOnly: true } | null {
    const preview = this.previews.get(tab.cdpSessionId)
    return preview ? { name: preview.name, readOnly: true } : null
  }
  listTabs(): { exists: boolean; agentTabId: string | null; tabs: Array<{ tabId: string }> } {
    return { exists: this.tabs.size > 0, agentTabId: this.active ?? null, tabs: [...this.tabs.keys()].map(tabId => ({ tabId })) }
  }
  selectTab(id: string): void { if (!this.tabs.has(id)) throw new Error('Core 浏览器标签不存在。'); this.active = id }
  async closeTab(id: string): Promise<void> {
    const tab = await this.tab(id)
    await (await this.connect()).send('Target.disposeBrowserContext', { browserContextId: tab.browserContextId })
    this.previews.delete(tab.cdpSessionId)
    this.tabs.delete(id)
    if (this.active === id) this.active = this.tabs.keys().next().value
  }
  async dispose(): Promise<void> {
    await this.queue
    this.disposed = true
    if (this.connection) await (await this.connection).close()
    this.connection = undefined; this.tabs.clear(); this.previews.clear(); this.active = undefined
  }
}
export function createCoreBrowserHost(options: CoreBrowserHostOptions = {}): CoreBrowserHost { return new CoreBrowserHost(options) }
