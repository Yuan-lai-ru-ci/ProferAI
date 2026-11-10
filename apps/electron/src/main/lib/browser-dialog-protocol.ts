import { randomUUID } from 'node:crypto'
import type { OnBeforeRequestListenerDetails, Session, WebContents, WebFrameMain } from 'electron'

export const BROWSER_DIALOG_SCHEME = 'profer-browser-dialog'
const MAX_BODY_BYTES = 128_000
const GRANT_TTL_MS = 5_000

export interface BrowserDialogRequest {
  type: 'alert' | 'confirm' | 'prompt'
  message: string
  defaultPrompt: string
  /** 来自 Electron frame，不信任网页正文自报的来源。 */
  origin: string
}
export type BrowserDialogValue = boolean | string | null
interface Endpoint {
  contents: WebContents
  current: () => boolean
  request: (input: BrowserDialogRequest, alive: () => boolean, signal: AbortSignal) => Promise<BrowserDialogValue>
}
interface RegisteredEndpoint extends Endpoint {
  active: boolean
  generation: number
  frameVersions: Map<number, number>
}
interface Grant {
  endpoint: RegisteredEndpoint
  generation: number
  frameVersion: number
  frame: WebFrameMain
  frameUrl: string
  frameToken: string
  processId: number
  origin: string
  createdAt: number
}

function frameAlive(grant: Grant): boolean {
  try {
    return grant.endpoint.active && grant.endpoint.current() && grant.endpoint.generation === grant.generation
      && (grant.endpoint.frameVersions.get(grant.frame.frameTreeNodeId) ?? 0) === grant.frameVersion
      && !grant.endpoint.contents.isDestroyed() && !grant.frame.isDestroyed()
      && !grant.frame.detached && grant.frame.url === grant.frameUrl
      && grant.frame.frameToken === grant.frameToken && grant.frame.processId === grant.processId
      && (grant.frame === grant.endpoint.contents.mainFrame || grant.frame.top === grant.endpoint.contents.mainFrame)
  } catch { return false }
}

function displayOrigin(frame: WebFrameMain): string {
  try {
    const url = new URL(frame.origin)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
  } catch { /* opaque frame 和授权本地预览不显示内部 token URL */ }
  return '本地或隔离网页'
}

/** 唯一能力是等待网页提示的标量响应；没有通用 IPC、文件访问或网络代理。 */
export class BrowserDialogProtocol {
  private readonly endpoints = new Map<string, RegisteredEndpoint>()
  private readonly grants = new Map<string, Grant>()
  private readonly usedRequests = new Map<string, number>()

  constructor(browserSession: Session) {
    browserSession.protocol.handle(BROWSER_DIALOG_SCHEME, request => this.handle(request))
  }

  register(endpoint: Endpoint): { source: string; dispose: () => void } {
    const token = randomUUID()
    const registered: RegisteredEndpoint = { ...endpoint, active: true, generation: 0, frameVersions: new Map() }
    const navigating = (details: Electron.WebContentsDidStartNavigationEventParams): void => {
      if (details.isSameDocument) return
      if (details.isMainFrame || registered.frameVersions.size >= 512) {
        registered.generation++
        registered.frameVersions.clear()
      } else if (details.frame) {
        const id = details.frame.frameTreeNodeId
        registered.frameVersions.set(id, (registered.frameVersions.get(id) ?? 0) + 1)
      }
    }
    endpoint.contents.on('did-start-navigation', navigating)
    this.endpoints.set(token, registered)
    return { source: browserDialogSource(`${BROWSER_DIALOG_SCHEME}://${token}/`), dispose: () => {
      registered.active = false
      endpoint.contents.removeListener('did-start-navigation', navigating)
      this.endpoints.delete(token)
      for (const [url, grant] of this.grants) if (grant.endpoint === registered) this.grants.delete(url)
      for (const url of this.usedRequests.keys()) if (url.startsWith(`${BROWSER_DIALOG_SCHEME}://${token}/`)) this.usedRequests.delete(url)
    } }
  }

  /** 接在现有 webRequest 门禁中；protocol.handle 本身没有 sender 身份，不可仅凭 URL 放行。 */
  authorize(details: OnBeforeRequestListenerDetails): boolean {
    const now = Date.now()
    for (const [url, grant] of this.grants) if (now - grant.createdAt > GRANT_TTL_MS || !frameAlive(grant)) this.grants.delete(url)
    for (const [url, createdAt] of this.usedRequests) if (now - createdAt > 5 * 60_000) this.usedRequests.delete(url)
    try {
      const url = new URL(details.url)
      const endpoint = this.endpoints.get(url.hostname)
      const frame = details.frame
      if (url.protocol !== `${BROWSER_DIALOG_SCHEME}:` || url.username || url.password || url.port || url.search || url.hash
        || !/^\/[a-f0-9]{32}$/.test(url.pathname) || details.method !== 'POST' || details.resourceType !== 'xhr'
        || !endpoint || endpoint.contents.id !== details.webContentsId || !frame
        || this.usedRequests.has(details.url) || this.grants.size >= 64 || this.usedRequests.size >= 4096) return false
      // 只接受内存中的小型 JSON。拒绝文件上传，避免本通道间接读取本地文件。
      if (!details.uploadData?.length || details.uploadData.some(part => !part.bytes || !!part.file)
        || details.uploadData.reduce((size, part) => size + (part.bytes?.length ?? MAX_BODY_BYTES + 1), 0) > MAX_BODY_BYTES) return false
      const grant: Grant = { endpoint, generation: endpoint.generation, frameVersion: endpoint.frameVersions.get(frame.frameTreeNodeId) ?? 0,
        frame, frameUrl: frame.url, frameToken: frame.frameToken, processId: frame.processId, origin: displayOrigin(frame), createdAt: now }
      if (!frameAlive(grant)) return false
      this.grants.set(details.url, grant)
      this.usedRequests.set(details.url, now)
      return true
    } catch { return false }
  }

  private async handle(request: Request): Promise<Response> {
    const grant = this.grants.get(request.url)
    this.grants.delete(request.url)
    if (request.method !== 'POST' || !grant || Date.now() - grant.createdAt > GRANT_TTL_MS || !frameAlive(grant)) return new Response(null, { status: 403 })
    try {
      // authorize 已在 Electron 的内存 uploadData 上验证长度，不读取文件/任意流。
      const body = await request.text()
      if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) return new Response(null, { status: 413 })
      const raw: unknown = JSON.parse(body)
      if (!raw || typeof raw !== 'object') return new Response(null, { status: 400 })
      const input = raw as Record<string, unknown>
      if (!['alert', 'confirm', 'prompt'].includes(String(input.type)) || typeof input.message !== 'string' || input.message.length > 8000
        || typeof input.defaultPrompt !== 'string' || input.defaultPrompt.length > 10_000 || !frameAlive(grant)) return new Response(null, { status: 400 })
      const value = await grant.endpoint.request({ type: input.type as BrowserDialogRequest['type'], message: input.message, defaultPrompt: input.defaultPrompt, origin: grant.origin }, () => frameAlive(grant), request.signal)
      return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
    } catch { return new Response(null, { status: 400 }) }
  }
}

/** document-start 运行于每个 frame；闭包只持有固定标量 endpoint，不引入 Node/preload。 */
export function browserDialogSource(endpoint: string): string {
  return `(()=>{
    if(Object.getOwnPropertyDescriptor(globalThis,'alert')?.configurable===false)return;
    const XHR=globalThis.XMLHttpRequest,open=XHR.prototype.open,send=XHR.prototype.send;
    const stringify=JSON.stringify,parse=JSON.parse,text=String,encode=Uint8Array;
    const random=crypto.getRandomValues.bind(crypto);
    const call=(type,message='',defaultPrompt='')=>{
      const nonce=Array.from(random(new encode(16)),n=>n.toString(16).padStart(2,'0')).join('');
      const xhr=new XHR();open.call(xhr,'POST',${JSON.stringify(endpoint)}+nonce,false);
      send.call(xhr,stringify({type,message:text(message).slice(0,8000),defaultPrompt:text(defaultPrompt).slice(0,10000)}));
      return xhr.status===200?parse(xhr.responseText):null;
    };
    Object.defineProperties(globalThis,{
      alert:{configurable:false,writable:false,value:(message)=>{call('alert',message)}},
      confirm:{configurable:false,writable:false,value:(message)=>call('confirm',message)===true},
      prompt:{configurable:false,writable:false,value:(message,defaultPrompt)=>{const result=call('prompt',message,defaultPrompt);return typeof result==='string'?result:null}}
    });
  })()`
}
