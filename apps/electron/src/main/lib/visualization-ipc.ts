import { ipcMain, dialog, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  VISUALIZATION_IPC,
  type VisualizationContext,
  type VisualizationContent,
  type VisualizationRecord,
  type VisualizationViewState,
} from '@profer/shared'
import { getAgentSessionMeta } from './agent-session-manager'
import { getAgentWorkspace } from './agent-workspace-manager'
import { agentSessionVisualizationsDir, getAgentSessionWorkspacePath } from './config-paths'
import { assertMainWindowSender, type MainWindowGetter } from './ipc-sender-guard'
import { buildVisualizationExport } from './visualization-export'
import { listVisualizations, readVisualization, readVisualizationViewState, saveVisualizationViewState } from './visualization-records'

interface VisualizationIpcDependencies {
  getMainWindow: MainWindowGetter
  getSession?: typeof getAgentSessionMeta
  getWorkspace?: typeof getAgentWorkspace
  getSessionWorkspacePath?: typeof getAgentSessionWorkspacePath
  /** 可视化记录存储根（配置目录，刻意与会话工作区分离）。 */
  getVisualizationStorePath?: typeof agentSessionVisualizationsDir
  saveDialog?: typeof dialog.showSaveDialog
  writeFile?: typeof writeFile
  list?: typeof listVisualizations
  read?: typeof readVisualization
  readViewState?: typeof readVisualizationViewState
  saveViewState?: typeof saveVisualizationViewState
}

interface MainFrameEvent extends IpcMainInvokeEvent {
  senderFrame: IpcMainInvokeEvent['senderFrame']
}

function assertMainFrame(event: MainFrameEvent): void {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('仅允许主窗口主页面调用会话可视化 IPC')
  }
}

function requiredString(value: unknown, name: string, maxLength = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || value.includes('\0')) {
    throw new Error(`${name}参数非法`)
  }
  return value.trim()
}

function requiredIdentifier(value: unknown, name: string): string {
  const id = requiredString(value, name)
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`${name}参数非法`)
  return id
}

function parseRevision(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, 'revision', 200)
}

function parseRequest(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('可视化请求参数非法')
  return value as Record<string, unknown>
}

function safeFilename(title: string): string {
  const normalized = title
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .trim()
    .slice(0, 100)
  return `${normalized || 'visualization'}.html`
}

export function createVisualizationIpcHandlers(deps: VisualizationIpcDependencies) {
  const getSession = deps.getSession ?? getAgentSessionMeta
  const getWorkspace = deps.getWorkspace ?? getAgentWorkspace
  const getSessionWorkspacePath = deps.getSessionWorkspacePath ?? getAgentSessionWorkspacePath
  const getVisualizationStorePath = deps.getVisualizationStorePath ?? agentSessionVisualizationsDir
  const saveDialog = deps.saveDialog ?? dialog.showSaveDialog
  const write = deps.writeFile ?? writeFile
  const list = deps.list ?? listVisualizations
  const read = deps.read ?? readVisualization
  const readViewState = deps.readViewState ?? readVisualizationViewState
  const saveViewState = deps.saveViewState ?? saveVisualizationViewState

  const contextFor = (sessionIdValue: unknown): VisualizationContext => {
    const sessionId = requiredIdentifier(sessionIdValue, 'sessionId')
    const meta = getSession(sessionId)
    if (!meta) throw new Error('Agent会话不存在')
    const workspace = meta.workspaceId ? getWorkspace(meta.workspaceId) : undefined
    if (!workspace) throw new Error('会话工作区不存在')
    const agentCwd = getSessionWorkspacePath(workspace.slug, sessionId)
    if (!agentCwd || typeof agentCwd !== 'string') throw new Error('会话工作区路径不可用')
    const storageDir = getVisualizationStorePath(sessionId)
    if (!storageDir || typeof storageDir !== 'string') throw new Error('会话可视化存储路径不可用')
    return { sessionId, agentCwd, storageDir, allowedRoots: [] }
  }

  const authorize = (event: MainFrameEvent): void => {
    assertMainFrame(event)
    assertMainWindowSender(event, deps.getMainWindow)
  }

  return {
    list: (event: MainFrameEvent, sessionId: unknown): Promise<VisualizationRecord[]> => {
      authorize(event)
      return list(contextFor(sessionId))
    },
    read: (event: MainFrameEvent, raw: unknown): Promise<VisualizationContent> => {
      authorize(event)
      const input = parseRequest(raw)
      const ctx = contextFor(input.sessionId)
      const id = requiredIdentifier(input.id, 'id')
      const revision = parseRevision(input.revision)
      return read(ctx, id, revision)
    },
    readViewState: (event: MainFrameEvent, raw: unknown): Promise<VisualizationViewState> => {
      authorize(event)
      const input = parseRequest(raw)
      const ctx = contextFor(input.sessionId)
      const id = requiredIdentifier(input.id, 'id')
      const revision = requiredString(input.revision, 'revision', 200)
      return readViewState(ctx, id, revision)
    },
    saveViewState: (event: MainFrameEvent, raw: unknown): Promise<void> => {
      authorize(event)
      const input = parseRequest(raw)
      const ctx = contextFor(input.sessionId)
      const id = requiredIdentifier(input.id, 'id')
      const revision = requiredString(input.revision, 'revision', 200)
      if (!input.state || typeof input.state !== 'object' || Array.isArray(input.state)) throw new Error('可视化状态参数非法')
      return saveViewState(ctx, id, revision, input.state as VisualizationViewState)
    },
    export: async (event: MainFrameEvent, raw: unknown): Promise<string | null> => {
      authorize(event)
      const input = parseRequest(raw)
      const ctx = contextFor(input.sessionId)
      const id = requiredIdentifier(input.id, 'id')
      const revision = requiredString(input.revision, 'revision', 200)
      const content = await read(ctx, id, revision)
      if (typeof content.html !== 'string') throw new Error('可视化 HTML 内容无效')
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = win
        ? await saveDialog(win, {
            title: '导出可视化',
            defaultPath: safeFilename(content.record.title),
            filters: [{ name: 'HTML', extensions: ['html'] }],
          })
        : await saveDialog({
            title: '导出可视化',
            defaultPath: safeFilename(content.record.title),
            filters: [{ name: 'HTML', extensions: ['html'] }],
          })
      if (result.canceled || !result.filePath) return null
      const state = await readViewState(ctx, id, revision)
      await write(result.filePath, buildVisualizationExport(content, state), 'utf-8')
      return basename(result.filePath)
    },
  }
}

let registered = false

export function registerVisualizationIpc(deps: VisualizationIpcDependencies): void {
  if (registered) return
  registered = true
  const handlers = createVisualizationIpcHandlers(deps)
  ipcMain.handle(VISUALIZATION_IPC.LIST, handlers.list)
  ipcMain.handle(VISUALIZATION_IPC.READ, handlers.read)
  ipcMain.handle(VISUALIZATION_IPC.VIEW_STATE, handlers.readViewState)
  ipcMain.handle(VISUALIZATION_IPC.SAVE_VIEW_STATE, handlers.saveViewState)
  ipcMain.handle(VISUALIZATION_IPC.EXPORT, handlers.export)
}
