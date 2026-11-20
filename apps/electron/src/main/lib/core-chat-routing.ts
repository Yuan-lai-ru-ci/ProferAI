import { isAbsolute } from 'node:path'
import { namespaceCoreChatId, parseCoreChatId, FILE_PREFIX, decodeFile, mapAttachments } from './core-chat-projection'
export { namespaceCoreChatId, parseCoreChatId, projectCoreChatEvent } from './core-chat-projection'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { CHAT_IPC_CHANNELS } from '@profer/shared'
import { localCoreOwnsBusinessData } from './core-business-ownership'
import { getLocalCoreClient } from './core-local-bridge'
import { getActiveCoreClient, listCoreTargets } from './core-target-service'

interface ChatClient {
  chatOperation<T>(operation: string, args: unknown[], assertCurrent?: () => void): Promise<T>
}
export interface ChatRoutingSnapshot {
  targetId: string
  generation: number
  coreId?: string
  ownsBusinessData: boolean
  capabilities: readonly string[]
  client: ChatClient | null
}
function snapshot(): ChatRoutingSnapshot {
  const state = listCoreTargets()
  const selected = state.targets.find(target => target.id === state.currentId)
  return { targetId: state.currentId, generation: state.generation, coreId: selected?.coreId,
    ownsBusinessData: state.currentId !== 'local' || localCoreOwnsBusinessData(),
    capabilities: selected?.capabilities ?? [], client: state.currentId === 'local' ? getLocalCoreClient() : getActiveCoreClient() }
}


const ID_FIRST = new Set<string>([
  CHAT_IPC_CHANNELS.GET_MESSAGES, CHAT_IPC_CHANNELS.GET_RECENT_MESSAGES, CHAT_IPC_CHANNELS.UPDATE_TITLE,
  CHAT_IPC_CHANNELS.REGENERATE_TITLE, CHAT_IPC_CHANNELS.UPDATE_MODEL, CHAT_IPC_CHANNELS.DELETE_CONVERSATION,
  CHAT_IPC_CHANNELS.TOGGLE_PIN, CHAT_IPC_CHANNELS.TOGGLE_ARCHIVE, CHAT_IPC_CHANNELS.STOP_GENERATION,
  CHAT_IPC_CHANNELS.ADD_KNOWLEDGE_REFERENCES, CHAT_IPC_CHANNELS.DELETE_MESSAGE, CHAT_IPC_CHANNELS.TRUNCATE_MESSAGES_FROM,
  CHAT_IPC_CHANNELS.GET_BRANCH, CHAT_IPC_CHANNELS.SET_ACTIVE_PATH, CHAT_IPC_CHANNELS.GET_BRANCH_TREE,
  CHAT_IPC_CHANNELS.FORK_BRANCH_AT, CHAT_IPC_CHANNELS.GET_MESSAGE_CONTENT, CHAT_IPC_CHANNELS.UPDATE_CONTEXT_DIVIDERS,
])
const OBJECT_FIRST = new Set<string>([CHAT_IPC_CHANNELS.SEND_MESSAGE, CHAT_IPC_CHANNELS.AUTO_TITLE, CHAT_IPC_CHANNELS.SAVE_ATTACHMENT])
const FILE_FIRST = new Set<string>([CHAT_IPC_CHANNELS.READ_ATTACHMENT, CHAT_IPC_CHANNELS.DELETE_ATTACHMENT, CHAT_IPC_CHANNELS.EXTRACT_ATTACHMENT_TEXT, CHAT_IPC_CHANNELS.COPY_IMAGE, CHAT_IPC_CHANNELS.SAVE_IMAGE_AS])
const META_RESULT = new Set<string>([CHAT_IPC_CHANNELS.CREATE_CONVERSATION, CHAT_IPC_CHANNELS.UPDATE_TITLE, CHAT_IPC_CHANNELS.UPDATE_MODEL,
  CHAT_IPC_CHANNELS.TOGGLE_PIN, CHAT_IPC_CHANNELS.TOGGLE_ARCHIVE, CHAT_IPC_CHANNELS.UPDATE_CONTEXT_DIVIDERS,
  CHAT_IPC_CHANNELS.AUTO_TITLE, CHAT_IPC_CHANNELS.REGENERATE_TITLE, CHAT_IPC_CHANNELS.CREATE_WELCOME_CONVERSATION])
const HOST_ONLY = new Set<string>([CHAT_IPC_CHANNELS.GET_TUTORIAL_CONTENT, CHAT_IPC_CHANNELS.GET_FRP_GUIDE_CONTENT,
  CHAT_IPC_CHANNELS.OPEN_FILE_DIALOG, CHAT_IPC_CHANNELS.SAVE_RESOURCE_FILE_AS])
const OPERATIONS = new Set<string>(Object.values(CHAT_IPC_CHANNELS).filter(channel => !channel.startsWith('chat:stream:')))

function scopeOf(value: unknown): { targetId: string; generation: number } | null {
  if (!value || typeof value !== 'object' || !('__proferCoreResourceScope' in value)) return null
  const scope = value.__proferCoreResourceScope
  if (!scope || typeof scope !== 'object' || !('targetId' in scope) || !('generation' in scope)
    || typeof scope.targetId !== 'string' || !Number.isSafeInteger(scope.generation)) throw new Error('Core Chat目标scope无效')
  return scope as { targetId: string; generation: number }
}
function hasOwnedIdentity(channel: string, args: unknown[]): boolean {
  const owned = (value: unknown): boolean => typeof value === 'string' && (value.startsWith('core-chat:') || value.startsWith(FILE_PREFIX))
  if (ID_FIRST.has(channel) || FILE_FIRST.has(channel)) return owned(args[0])
  if (OBJECT_FIRST.has(channel)) {
    const value = args[0]
    return !!value && typeof value === 'object' && 'conversationId' in value && owned(value.conversationId)
  }
  return false
}
function rawId(value: unknown, coreId: string): string {
  const parsed = typeof value === 'string' ? parseCoreChatId(value) : null
  if (!parsed || parsed.coreId !== coreId) throw new Error('Chat对话所属Core与当前目标不一致')
  return parsed.conversationId
}

function mapResult(channel: string, value: unknown, coreId: string): unknown {
  const withAttachments = mapAttachments(value, coreId, false)
  const meta = (item: unknown) => item && typeof item === 'object' && 'id' in item && typeof item.id === 'string'
    ? { ...item, id: namespaceCoreChatId(item.id, coreId) } : item
  if (channel === CHAT_IPC_CHANNELS.LIST_CONVERSATIONS && Array.isArray(withAttachments)) return withAttachments.map(meta)
  if (META_RESULT.has(channel)) return meta(withAttachments)
  if (channel === CHAT_IPC_CHANNELS.SEARCH_MESSAGES && Array.isArray(withAttachments)) return withAttachments.map(item =>
    item && typeof item === 'object' && 'conversationId' in item && typeof item.conversationId === 'string'
      ? { ...item, conversationId: namespaceCoreChatId(item.conversationId, coreId) } : item)
  return withAttachments
}


/** 调用scope、对话所属身份、HTTP前与回执后同时检查，断连不归还桌面写权。 */
export async function routeCoreChat(channel: string, input: unknown[], readSnapshot = snapshot): Promise<{ result: unknown } | null> {
  const current = readSnapshot()
  const args = input.slice()
  while (args.length && args.at(-1) === undefined) args.pop()
  const scope = scopeOf(args.at(-1))
  if (scope) args.pop()
  if (scope && (scope.targetId !== current.targetId || scope.generation !== current.generation)) throw new Error('Core已切换，Chat请求目标已过期')
  if (!current.ownsBusinessData) {
    if (hasOwnedIdentity(channel, args)) throw new Error('Chat对话所属Core与当前目标不一致')
    return null
  }
  if (!scope) throw new Error('Core Chat请求缺少目标scope')
  if (!current.client || !current.coreId) throw new Error('当前Core未连接，Chat不会回退本机')
  if (!current.capabilities.includes('chat')) throw new Error('当前Core不支持Chat，请更新Core；不会回退本机')
  if (!OPERATIONS.has(channel)) throw new Error(`当前Core不支持Chat操作：${channel}`)
  if (HOST_ONLY.has(channel)) return null
  // Agent的本机图片预览复用同一Chat宿主端口；只读绝对路径沿既有安全目录校验，
  // Chat附件必须携带Core身份，远端或裸相对路径绝不走这条宿主分支。
  if (current.targetId === 'local' && typeof args[0] === 'string' && isAbsolute(args[0])
    && [CHAT_IPC_CHANNELS.READ_ATTACHMENT, CHAT_IPC_CHANNELS.EXTRACT_ATTACHMENT_TEXT, CHAT_IPC_CHANNELS.COPY_IMAGE, CHAT_IPC_CHANNELS.SAVE_IMAGE_AS].some(item => item === channel)) return null
  const coreId = current.coreId
  if (ID_FIRST.has(channel)) args[0] = rawId(args[0], coreId)
  if (OBJECT_FIRST.has(channel)) {
    const object = args[0]
    if (!object || typeof object !== 'object' || !('conversationId' in object)) throw new Error('Chat请求缺少对话所属Core身份')
    args[0] = { ...object, conversationId: rawId(object.conversationId, coreId) }
  }
  if (FILE_FIRST.has(channel)) {
    if (typeof args[0] !== 'string') throw new Error('Chat附件路径无效')
    args[0] = decodeFile(args[0], coreId)
  }
  const imageExport = channel === CHAT_IPC_CHANNELS.COPY_IMAGE || channel === CHAT_IPC_CHANNELS.SAVE_IMAGE_AS
  const assertCurrent = (): void => {
    const latest = readSnapshot()
    if (latest.targetId !== current.targetId || latest.generation !== current.generation || latest.client !== current.client || latest.coreId !== current.coreId) throw new Error('Core已切换，忽略旧Core Chat响应')
  }
  const converted = mapAttachments(args, coreId, true) as unknown[]
  const response = await current.client.chatOperation<unknown>(imageExport ? CHAT_IPC_CHANNELS.READ_ATTACHMENT : channel, imageExport ? converted.slice(0, 1) : converted, assertCurrent)
  assertCurrent()
  return { result: mapResult(channel, response, coreId) }
}

export function registerCoreChatHandler(channel: string, fallback: (event: IpcMainInvokeEvent, ...args: never[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...input: unknown[]) => {
    const routed = await routeCoreChat(channel, input)
    if (routed) {
      if (channel === CHAT_IPC_CHANNELS.COPY_IMAGE || channel === CHAT_IPC_CHANNELS.SAVE_IMAGE_AS) {
        if (typeof routed.result !== 'string') throw new Error('Core返回的图片数据无效')
        const { clipboard, nativeImage, dialog, BrowserWindow } = await import('electron')
        const image = nativeImage.createFromBuffer(Buffer.from(routed.result, 'base64'))
        if (image.isEmpty()) throw new Error('Core附件不是可用图片')
        if (channel === CHAT_IPC_CHANNELS.COPY_IMAGE) { clipboard.writeImage(image); return true }
        const state = snapshot()
        const filename = typeof input[1] === 'string' ? input[1].replace(/.*[/\\\\]/, '') : 'image.png'
        const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()!, { defaultPath: filename })
        if (result.canceled || !result.filePath) return false
        const latest = snapshot()
        if (latest.targetId !== state.targetId || latest.generation !== state.generation || latest.client !== state.client) throw new Error('Core已切换，取消旧Core图片导出')
        const { writeFileSync } = await import('node:fs')
        writeFileSync(result.filePath, Buffer.from(routed.result, 'base64'))
        return true
      }
      return routed.result
    }
    const args = input.slice()
    if (scopeOf(args.at(-1))) args.pop()
    return fallback(event, ...args as never[])
  })
}
