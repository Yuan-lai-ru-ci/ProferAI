import { app, BrowserWindow, ipcMain, session, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { AgentPreviewFileKind, AgentPreviewImage, AgentPreviewRenderOutput, AgentPreviewRenderTask, InspectPreviewScope } from '@profer/shared'
import { VITE_DEV_SERVER_URL } from './config-paths'
import { handleProferFileRequest } from './local-file-protocol'

export interface AgentPreviewRenderRequest {
  fileName: string
  kind: AgentPreviewFileKind
  scope: InspectPreviewScope
  page?: number
}

export type AgentPreviewRenderResult = AgentPreviewRenderOutput

interface PendingRender {
  resolve: (result: AgentPreviewRenderResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class AgentPreviewRendererError extends Error {
  constructor(
    readonly code: 'page_out_of_range' | 'renderer_failed',
    message: string,
    readonly retryable = true,
  ) {
    super(message)
    this.name = 'AgentPreviewRendererError'
  }
}

const RENDER_TIMEOUT_MS = 30_000
const PREVIEW_PARTITION = 'agent-preview-hidden'
const PACKAGED_RENDERER_BASE_URL = pathToFileURL(`${join(__dirname, 'renderer')}/`).toString()
let previewWindow: BrowserWindow | null = null
let loaded = false
let rendererReady = false
let handlersInstalled = false
let policyInstalled = false
let renderChain: Promise<void> = Promise.resolve()
const dataById = new Map<string, AgentPreviewRenderTask>()
const pending = new Map<string, PendingRender>()

export function isSafeAgentPreviewSourceUrl(value: string): boolean {
  return /^profer-file:\/\/[a-z0-9-]+(?:\/[^?#]*)?$/i.test(value)
}

function installPreviewSessionPolicy(): void {
  if (policyInstalled) return
  policyInstalled = true
  const previewSession = session.fromPartition(PREVIEW_PARTITION)
  // Electron 运行时必有这些 API；窄保护仅让不完整 Electron mock 的主进程单测可加载。
  if (!previewSession?.protocol || !previewSession.webRequest) return
  previewSession.protocol.handle('profer-file', handleProferFileRequest)
  previewSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  previewSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url
    // 开发入口及其 Vite 模块必须可加载；嵌入内容和其资源只能是 opaque profer-file token。
    const allowed = url.startsWith('profer-file://')
      || url.startsWith('data:')
      || url.startsWith('blob:')
      || url.startsWith('about:')
      || (!app.isPackaged && /^http:\/\/localhost:5174(?:\/|$)/.test(url))
      || (app.isPackaged && url.startsWith(PACKAGED_RENDERER_BASE_URL))
    callback({ cancel: !allowed })
  })
}

function cleanup(id: string): void {
  const current = pending.get(id)
  if (current) clearTimeout(current.timer)
  pending.delete(id)
  dataById.delete(id)
}

function rejectAll(error: Error): void {
  for (const id of [...pending.keys()]) {
    const current = pending.get(id)
    cleanup(id)
    current?.reject(error)
  }
}

function isMainPreviewFrame(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return event.senderFrame !== null && event.senderFrame === event.sender.mainFrame
}

function installHandlers(): void {
  if (handlersInstalled) return
  handlersInstalled = true
  // Task payload is pushed only to the hidden window's main frame; no iframe can request it.
  ipcMain.handle('agent-preview:capture', async (event, id: string): Promise<string> => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    if (!isMainPreviewFrame(event) || !senderWindow || senderWindow.isDestroyed() || senderWindow !== previewWindow || !pending.has(id)) {
      throw new AgentPreviewRendererError('renderer_failed', '无效的 Agent 预览截图请求')
    }
    const image = await senderWindow.webContents.capturePage()
    return image.toPNG().toString('base64')
  })
  ipcMain.on('agent-preview:ready', (event) => {
    if (isMainPreviewFrame(event) && previewWindow && !previewWindow.isDestroyed() && event.sender.id === previewWindow.webContents.id) rendererReady = true
  })
  ipcMain.on('agent-preview:result', (event, id: string, result: AgentPreviewRenderResult) => {
    if (!isMainPreviewFrame(event) || !previewWindow || previewWindow.isDestroyed() || event.sender.id !== previewWindow.webContents.id) return
    const current = pending.get(id)
    if (!current) return
    cleanup(id)
    current.resolve(result)
  })
  ipcMain.on('agent-preview:error', (event, id: string, payload: { code?: string; message?: string }) => {
    if (!isMainPreviewFrame(event) || !previewWindow || previewWindow.isDestroyed() || event.sender.id !== previewWindow.webContents.id) return
    const current = pending.get(id)
    if (!current) return
    cleanup(id)
    const code = payload.code === 'page_out_of_range' ? 'page_out_of_range' : 'renderer_failed'
    current.reject(new AgentPreviewRendererError(code, payload.message || 'Agent 预览渲染失败', code !== 'page_out_of_range'))
  })
}

function ensureWindow(): BrowserWindow {
  if (previewWindow && !previewWindow.isDestroyed()) return previewWindow
  installHandlers()
  installPreviewSessionPolicy()
  loaded = false
  rendererReady = false
  previewWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: PREVIEW_PARTITION,
      // Silurus/PDF rendering must progress while this explicitly hidden window is not focused.
      backgroundThrottling: false,
    },
  })
  previewWindow.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }))
  previewWindow.webContents.on?.('will-navigate', (event, url) => {
    const isAppEntry = (!app.isPackaged && url.startsWith(VITE_DEV_SERVER_URL))
      || (app.isPackaged && url.startsWith(PACKAGED_RENDERER_BASE_URL))
    if (!isAppEntry) event.preventDefault()
  })
  previewWindow.on('closed', () => {
    rejectAll(new AgentPreviewRendererError('renderer_failed', 'Agent 预览 renderer 已关闭'))
    previewWindow = null
    loaded = false
    rendererReady = false
  })
  previewWindow.webContents.once?.('did-finish-load', () => { loaded = true })
  if (app.isPackaged) {
    void previewWindow.loadFile(join(__dirname, 'renderer', 'index.html'), { query: { window: 'agent-preview' } })
  } else {
    void previewWindow.loadURL(`${VITE_DEV_SERVER_URL}?window=agent-preview`)
  }
  return previewWindow
}

function waitForRenderer(win: BrowserWindow): Promise<void> {
  if (loaded && rendererReady) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new AgentPreviewRendererError('renderer_failed', 'Agent 预览 renderer 加载超时')), RENDER_TIMEOUT_MS)
    const interval = setInterval(() => {
      if (loaded && rendererReady) {
        clearTimeout(timer)
        clearInterval(interval)
        resolve()
        return
      }
      if (win.isDestroyed()) {
        clearTimeout(timer)
        clearInterval(interval)
        reject(new AgentPreviewRendererError('renderer_failed', 'Agent 预览 renderer 已关闭'))
      }
    }, 25)
  })
}

async function renderOne(request: AgentPreviewRenderRequest, sourceUrl: string, text?: string): Promise<AgentPreviewRenderResult> {
  if (!isSafeAgentPreviewSourceUrl(sourceUrl)) throw new AgentPreviewRendererError('renderer_failed', '预览资源不是受控的 profer-file URL')
  const win = ensureWindow()
  await waitForRenderer(win)
  const id = randomUUID()
  const task: AgentPreviewRenderTask = { id, ...request, sourceUrl, text }
  dataById.set(id, task)
  return new Promise<AgentPreviewRenderResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup(id)
      reject(new AgentPreviewRendererError('renderer_failed', 'Agent 预览 renderer 渲染超时'))
    }, RENDER_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    if (win.isDestroyed()) {
      cleanup(id)
      reject(new AgentPreviewRendererError('renderer_failed', 'Agent 预览 renderer 已关闭'))
      return
    }
    win.webContents.send('agent-preview:render', task)
  })
}

/**
 * 在一个受控隐藏 renderer 中串行渲染，避免并发请求串台。
 * `sourceUrl` 必须由主进程通过 local-file-protocol 签发，不能由 Agent 输入直接传入。
 */
export function renderAgentPreview(request: AgentPreviewRenderRequest, sourceUrl: string, text?: string): Promise<AgentPreviewRenderResult> {
  const result = renderChain.then(() => renderOne(request, sourceUrl, text))
  renderChain = result.then(() => undefined, () => undefined)
  return result
}

export function disposeAgentPreviewRenderer(): void {
  rejectAll(new AgentPreviewRendererError('renderer_failed', 'Agent 预览 renderer 已释放'))
  if (previewWindow && !previewWindow.isDestroyed()) previewWindow.destroy()
  previewWindow = null
  loaded = false
  rendererReady = false
}
