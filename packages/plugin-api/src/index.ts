/**
 * @profer/plugin-api — Profer 第三方插件公开契约。
 *
 * 此包保持浏览器安全且不依赖 Electron。插件作者只依赖这里的稳定类型，
 * 不直接依赖 Profer 内部的 @profer/shared。
 */

export const PROFER_PLUGIN_MANIFEST_FILE = 'profer-plugin.json'
export const PROFER_PLUGIN_SCHEMA_VERSION = 1

/** 插件 ID 使用反向域名形式，避免市场与本地插件命名冲突。 */
export const PROFER_PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/
/** 页面 ID 为插件内部稳定 slug。 */
export const PROFER_PLUGIN_PAGE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export type ProferPluginPermission =
  | 'pluginStorage'
  | 'window.floating'
  | 'models.read'
  | 'modelRouting.rules.write'
  | 'models.invoke'
  | 'context.read'
  | 'attachments.read'
  | 'network.fetch'
  | 'agent.tools'
  | 'workspace.read'
  | 'workspace.files.read'
  | 'workspace.files.write'
  | 'presets.read'
  | 'presets.switch'
  | 'sessions.read'
  | 'sessions.create'
  | 'sessions.configure'
  | 'sessions.control'
  | 'runtime.capabilities.read'
  | 'runtime.capabilities.inject'
  | 'secrets.readMetadata'
  | 'secrets.configure'
  | 'mcp.secrets.readMetadata'
  | 'mcp.secrets.write'

export const PROFER_PLUGIN_PERMISSIONS: readonly ProferPluginPermission[] = [
  'pluginStorage', 'window.floating', 'models.read', 'modelRouting.rules.write', 'models.invoke', 'context.read',
  'attachments.read', 'network.fetch', 'agent.tools', 'workspace.read', 'workspace.files.read',
  'workspace.files.write', 'presets.read', 'presets.switch', 'sessions.read', 'sessions.create',
  'sessions.configure', 'sessions.control', 'runtime.capabilities.read', 'runtime.capabilities.inject',
  'secrets.readMetadata', 'secrets.configure', 'mcp.secrets.readMetadata', 'mcp.secrets.write',
]

export type ProferPluginPagePlacement = 'settings' | 'tab' | 'sidebar' | 'floating'

/** 悬浮窗口声明性配置；最终窗口参数由宿主校验和钳制，插件不能借此绕过平台限制。 */
export interface ProferPluginFloatingWindowConfig {
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
  maxWidth?: number
  maxHeight?: number
  transparent?: boolean
  frame?: boolean
  alwaysOnTop?: boolean
  skipTaskbar?: boolean
  resizable?: boolean
  movable?: boolean
  showOnStart?: boolean
  /** 是否参与焦点循环；贞宠类页面应声明 false，点击窗口不夺主窗口焦点。 */
  focusable?: boolean
  /** macOS：在所有 Space（含其他应用全屏）可见；其他平台忽略。 */
  visibleOnAllWorkspaces?: boolean
  /** 初始鼠标穿透；运行时可经 window.floating.setIgnoreMouseEvents 切换。 */
  clickThrough?: boolean
}

/** 悬浮窗口运行时边界（宿主返回给插件的实际值）。 */
export interface ProferPluginFloatingWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 用户可覆盖页面入口的宿主摆放；hidden 表示左侧栏与顶栏都不展示（页面仍可经设置页打开，插件静默生效）。 */
export type ProferPluginPagePlacementPreference = 'sidebar' | 'tab' | 'hidden'

export interface ProferPluginPageContribution {
  id: string
  title: string
  /** 相对于插件根目录的 HTML 入口。 */
  entry: string
  /** 声明宿主入口；缺省保留旧版设置页和 Tab 入口。 */
  placements?: ProferPluginPagePlacement[]
  /** 悬浮窗口默认配置；仅当 placements 包含 'floating' 时生效。 */
  floatingWindow?: ProferPluginFloatingWindowConfig
  /** 相对于插件根目录的图标文件（png/jpg/webp/gif/svg/ico），用于左侧栏与顶栏入口；缺省用宿主占位图标。 */
  icon?: string
}

/** 未声明 placement 的 v1 页面保留设置页与 Tab 入口；显式声明后严格按清单开放。 */
export function allowsPluginPagePlacement(
  page: Pick<ProferPluginPageContribution, 'placements'>,
  placement: ProferPluginPagePlacement,
): boolean {
  return page.placements === undefined ? placement === 'tab' || placement === 'settings' : page.placements.includes(placement)
}

/**
 * 计算页面入口在左侧栏/顶栏表面是否展示：清单 allowlist 是硬边界，
 * 用户摆放偏好只能在清单声明的范围内收窄；偏好指向清单未声明的位置时按失效处理并回退清单行为。
 */
export function resolvePluginPageSurfaceVisibility(
  page: Pick<ProferPluginPageContribution, 'placements'>,
  preference: ProferPluginPagePlacementPreference | undefined,
  placement: 'sidebar' | 'tab',
): boolean {
  if (!allowsPluginPagePlacement(page, placement)) return false
  if (preference === 'hidden') return false
  if (preference && preference !== placement && allowsPluginPagePlacement(page, preference)) return false
  return true
}

/** 宿主执行的模型路由规则提供者。 */
export interface ProferPluginModelRoutingContribution {
  id: string
  kind: 'model-routing.rules.v1'
}

export interface ProferPluginContributions {
  pages?: ProferPluginPageContribution[]
  modelRoutingPolicies?: ProferPluginModelRoutingContribution[]
  tools?: ProferPluginToolContribution[]
  messageActions?: Array<{ id: string; title: string; pageId: string }>
}

export interface ProferPluginWorkspaceScope {
  workspaceId: string
  prefixes?: string[]
}

export interface ProferPluginProviderScope {
  providerId: string
  fields?: string[]
}

export interface ProferPluginManifest {
  schemaVersion: 1
  id: string
  name: string
  version: string
  description?: string
  publisher?: string
  homepage?: string
  /** 支持空格连接的 AND comparator，例如 >=0.15.80 <0.17.0。 */
  engines?: { profer: string }
  permissions?: ProferPluginPermission[]
  /** 工作区授权范围；缺省不代表所有工作区。 */
  workspaceScopes?: ProferPluginWorkspaceScope[]
  /** provider/resource scope；缺省不代表全部 provider 或字段。 */
  providerScopes?: ProferPluginProviderScope[]
  /** 精确 HTTPS origin，例如 https://api.example.com；不支持通配符。 */
  network?: { origins: string[]; credentials?: Array<{ id: string; title: string; origin: string; header: 'Authorization' | 'X-API-Key'; scheme?: 'bearer' | 'raw' }> }
  contributes: ProferPluginContributions
}

export interface ProferInstalledPlugin {
  manifest: ProferPluginManifest
  enabled: boolean
  /** 用户对页面宿主入口的摆放偏好（pageId → 偏好）；仅收窄清单声明的入口，不放大。 */
  pagePlacements?: Record<string, ProferPluginPagePlacementPreference>
  /** 当前实际生效的能力；用户撤销授权后恒为空数组。 */
  grantedPermissions?: ProferPluginPermission[]
  /** 用户是否已撤销该插件的授权；撤销后 `grantedPermissions` 为空且所有调用返回 `PLUGIN_REVOKED`。 */
  revoked?: boolean
  installedAt: number
  updatedAt: number
}

export type ProferPluginOperationStatus =
  | 'installed'
  | 'updated'
  | 'removed'
  | 'enabled'
  | 'disabled'
  | 'conflict'
  | 'error'

export interface ProferPluginOperationResult {
  ok: boolean
  status: ProferPluginOperationStatus
  message: string
  plugin?: ProferInstalledPlugin
}

export type ProferPluginViewKind = 'tab' | 'tool'

export type ProferPluginViewInstance =
  | { kind: 'tool' }
  | { kind: 'tab'; sessionId?: string }

export interface ProferPluginViewLayout {
  pluginId: string
  pageId: string
  instance: ProferPluginViewInstance
  rendererInstanceId: string
  layoutSourceRevision: number
  revision: number
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
  borderRadius: number
}

/** 插件页面当前的运行形态。 */
export type ProferPluginPageSurface = 'settings' | 'tab' | 'sidebar' | 'floating' | 'tool'

export interface ProferPluginContext {
  plugin: Pick<ProferPluginManifest, 'id' | 'name' | 'version' | 'description' | 'publisher'>
  pageId: string
  /** 当前页面实例的运行形态；悬浮页面与主窗口页面可据此区分布局。 */
  surface: ProferPluginPageSurface
  locale: string
  theme: 'light' | 'dark'
}

export interface ProferPluginHostApi {
  getContext(): Promise<ProferPluginContext>
  onContextChanged(callback: (context: ProferPluginContext) => void): () => void
  models: {
    list(): Promise<ProferPluginModel[]>
    generate(input: ProferPluginGenerateInput): Promise<ProferPluginGenerateResult>
  }
  routing: { getRules(): Promise<ProferPluginRoutingRule[]>; setRules(rules: ProferPluginRoutingRule[]): Promise<void> }
  context: { read(): Promise<ProferPluginTaskContext | null> }
  attachments: { select(): Promise<Array<{ name: string; text: string }>> }
  network: { fetch(input: ProferPluginFetchInput): Promise<ProferPluginFetchResult> }
  requests: { cancel(requestId: string): Promise<void> }
  tools: { register(id: string, handler: (args: Record<string, unknown>, context: { callId: string; isCancelled(): boolean; onCancel(callback: () => void): () => void }) => Promise<unknown>): Promise<void> }
  /** Provider 未注册时，宿主以 PLUGIN_OPERATION_NOT_SUPPORTED 稳定拒绝。 */
  workspace: PluginWorkspaceApi
  sessions: PluginSessionApi
  runtime: PluginRuntimeApi
  secrets: PluginSecretApi

  storage?: {
    get<T = unknown>(key: string): Promise<T | null>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
  }

  /** 悬浮窗口受控 API；只有声明 floating placement、授权 window.floating 且来自悬浮页面的调用才被宿主接受。 */
  window: {
    floating: {
      /** 打开（或复用已有）悬浮窗口并显示。 */
      open(): Promise<ProferPluginFloatingWindowBounds>
      show(): Promise<void>
      hide(): Promise<void>
      close(): Promise<void>
      isVisible(): Promise<boolean>
      getBounds(): Promise<ProferPluginFloatingWindowBounds | null>
      setBounds(bounds: Partial<Pick<ProferPluginFloatingWindowBounds, 'x' | 'y'>>): Promise<ProferPluginFloatingWindowBounds>
      /** 切换鼠标穿透；开启后鼠标事件直达下方窗口（forward 模式下页面仍收 mousemove，可自行实现退出穿透）。 */
      setIgnoreMouseEvents(ignore: boolean): Promise<void>
    }
  }
}

export const PROFER_PLUGIN_IPC_CHANNELS = {
  LIST: 'plugin:list',
  AUTHORIZE: 'plugin:authorize',
  SET_CREDENTIAL: 'plugin:set-credential',
  REVOKE: 'plugin:revoke',
  ACTIVATE: 'plugin:activate',
  ROUTING_GET: 'plugin:routing-get',
  ROUTING_SET: 'plugin:routing-set',
  ROUTING_CHANGED: 'plugin:routing-changed',
  SELECT_PACKAGE: 'plugin:select-package',
  INSTALL: 'plugin:install',
  SET_ENABLED: 'plugin:set-enabled',
  REMOVE: 'plugin:remove',
  OPEN_FOLDER: 'plugin:open-folder',
  SET_VIEW_LAYOUT: 'plugin:set-view-layout',
  READ_PAGE_ICON: 'plugin:read-page-icon',
  SET_PAGE_PLACEMENT: 'plugin:set-page-placement',
  HIDE_VIEW: 'plugin:hide-view',
  CLOSE_VIEW: 'plugin:close-view',
  CHANGED: 'plugin:changed',
} as const

/** 仅供插件专属 preload 使用，不向主 renderer 暴露。 */
export const PROFER_PLUGIN_HOST_CHANNELS = {
  GET_CONTEXT: 'plugin-host:get-context',
  CALL: 'plugin-host:call',
  CONTEXT_CHANGED: 'plugin-host:context-changed',
  TOOL_REGISTER: 'plugin-host:tool-register',
  TOOL_CALL: 'plugin-host:tool-call',
  TOOL_RESULT: 'plugin-host:tool-result',
  TOOL_CANCEL: 'plugin-host:tool-cancel',
  STORAGE_GET: 'plugin-host:storage-get',
  STORAGE_SET: 'plugin-host:storage-set',
  STORAGE_DELETE: 'plugin-host:storage-delete',
} as const

/** 参数采用可移植的简单类型，宿主同时生成 Claude / Pi 工具 schema。 */
export interface ProferPluginToolContribution {
  id: string
  title: string
  description: string
  pageId: string
  parameters: Record<string, { type: 'string' | 'number' | 'boolean'; description?: string; required?: boolean }>
}
export interface ProferPluginModel {
  channelId: string
  channelName: string
  modelId: string
  name: string
  provider: string
  available: boolean
  supportsChat: boolean
  supportsAgent: boolean
}
export interface ProferPluginRoutingRule {
  id: string
  title: string
  channelId: string
  modelId: string
  /** 本地时区 24 小时制；相同起止时间表示全天，支持跨午夜。 */
  start: string
  end: string
  days?: number[]
}
export interface ProferPluginRoutingState {
  pluginId: string | null
  lastDecision?: { channelId: string; modelId: string; reason: string; at: number }
}
export interface ProferPluginTaskReference {
  kind: 'chat' | 'agent'
  sessionId: string
  messageId?: string
  selection?: string
}
export interface ProferPluginTaskContext {
  kind: 'chat' | 'agent'
  sessionId: string
  selection?: string
  messages: Array<{ id: string; role: string; text: string }>
}
export interface ProferPluginGenerateInput {
  requestId: string
  channelId: string
  modelId: string
  prompt: string
  system?: string
  maxTokens?: number
}
export interface ProferPluginGenerateResult {
  text: string
  channelId: string
  modelId: string
}
export interface ProferPluginFetchInput {
  requestId: string
  url: string
  credentialId?: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
}
export interface ProferPluginFetchResult {
  status: number
  headers: Record<string, string>
  body: string
}

export interface PluginWorkspaceRef { workspaceId: string }
export interface PluginResourceScope extends PluginWorkspaceRef {
  resource: 'workspace' | 'file' | 'session' | 'preset'
  prefixes?: string[]
}
export interface PluginWorkspaceSummary extends PluginWorkspaceRef { displayName: string; revision: number }
export interface PluginFileEntry { path: string; kind: 'file' | 'directory'; size?: number; modifiedAt?: string }
export interface PluginFileRead { workspaceId: string; path: string; content: string; encoding: 'utf8'; truncated: boolean; revision: number }
export interface PluginFileWriteInput { workspaceId: string; path: string; content: string; mode: 'create' | 'replace'; expectedRevision: number; confirmationId?: string }
export interface PluginFileWriteResult { workspaceId: string; path: string; bytesWritten: number; revision: number; committed: true }
export type PluginSessionStatus = 'draft' | 'idle' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'unknown'
export interface PluginPresetMetadata { presetId: string; displayName: string; description?: string; version: number; enabled: boolean }
export interface PluginPresetCatalog { revision: number; items: PluginPresetMetadata[] }
export interface PluginSessionMetadata { sessionId: string; workspaceId: string; title: string; status: PluginSessionStatus; runtime: 'claude' | 'pi'; presetId: string | null; presetVersion?: number; createdAt: number; updatedAt: number; revision: number }
export type PluginCapabilityKind = 'preset' | 'skill' | 'tool' | 'service'
export interface PluginCapabilityRef { kind: PluginCapabilityKind; id: string; version?: number }
export interface PluginCapabilityDeclaration { references: PluginCapabilityRef[] }
export interface PluginRuntimeCapabilityView { snapshotId: string; fingerprint: string; runtime: 'claude' | 'pi'; references: PluginCapabilityRef[]; revision: number; effectiveFrom: 'next_turn' | 'new_session'; outcome?: 'committed' | 'rolled_back' | 'unknown' }
export interface PluginSecretRef { secretId: string; providerId: string; field: string }
export interface PluginSecretMetadata extends PluginSecretRef { configured: boolean; updatedAt: string }
export type ProferPluginErrorCode = 'PLUGIN_PERMISSION_DENIED' | 'PLUGIN_CONFIRMATION_REQUIRED' | 'PLUGIN_REVOKED' | 'PLUGIN_DISABLED' | 'PLUGIN_PAGE_CLOSED' | 'PLUGIN_REQUEST_CANCELLED' | 'PLUGIN_REQUEST_TIMEOUT' | 'PLUGIN_RATE_LIMITED' | 'PLUGIN_INVALID_ARGUMENT' | 'PLUGIN_WORKSPACE_NOT_FOUND' | 'PLUGIN_SESSION_NOT_FOUND' | 'PLUGIN_REFERENCE_NOT_FOUND' | 'PLUGIN_REVISION_CONFLICT' | 'PLUGIN_CAPABILITY_VERSION_CONFLICT' | 'PLUGIN_SECRET_STORAGE_UNAVAILABLE' | 'PLUGIN_SECRET_NOT_CONFIGURED' | 'PLUGIN_RUNTIME_UNAVAILABLE' | 'PLUGIN_RUNTIME_INJECTION_FAILED' | 'PLUGIN_OPERATION_NOT_SUPPORTED' | 'PLUGIN_HOST_NOT_READY' | 'PLUGIN_INTERNAL_ERROR'
export interface ProferPluginRpcRequest<T> { protocol: 'plugin-host.rpc.v1'; requestId: string; operation: string; payload: T; timeoutMs?: number }
export interface ProferPluginRpcSuccess<T> { protocol: 'plugin-host.rpc.v1'; ok: true; requestId: string; operation: string; value: T; revision?: number; auditEventId?: string }
export interface ProferPluginRpcFailure { protocol: 'plugin-host.rpc.v1'; ok: false; requestId: string; operation: string; error: { code: ProferPluginErrorCode; message: string; retryable: boolean; details?: Record<string, string | number | boolean> } }
export type ProferPluginRpcResponse<T> = ProferPluginRpcSuccess<T> | ProferPluginRpcFailure
/**
 * 插件页面侧捕获到的宿主 API 错误。
 *
 * 注意：这不是 `Error` 实例。Electron contextBridge 跨世界传递 Error 时会丢失自定义属性，
 * 因此 plugin preload 的 `call()` 以纯对象 reject 该形状，保证 `code` 等字段完整到达插件页面。
 * 请用 `isProferPluginError` 判断，不要依赖 `instanceof Error`。
 */
export interface ProferPluginError {
  name: 'ProferPluginError'
  code: ProferPluginErrorCode | string
  message: string
  retryable: boolean
  details?: Record<string, string | number | boolean>
  requestId: string
  operation: string
}
export const isProferPluginError = (value: unknown): value is ProferPluginError => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return candidate.name === 'ProferPluginError' && typeof candidate.code === 'string' && typeof candidate.message === 'string'
}
export interface PluginRequestContext { pluginId: string; pageId: string; ownerId: number; requestId: string; operation: string; signal: AbortSignal }
export interface PluginWorkspaceApi { list(): Promise<{ items: PluginWorkspaceSummary[]; revision: number }>; files: { list(input: { workspaceId: string; path?: string; depth?: number }): Promise<{ entries: PluginFileEntry[]; revision: number }>; read(input: { workspaceId: string; path: string; maxBytes?: number }): Promise<PluginFileRead>; write(input: PluginFileWriteInput): Promise<PluginFileWriteResult> } }
export interface PluginSessionApi {
  listPresets(input: { workspaceId: string }): Promise<PluginPresetCatalog>
  getPreset(input: { workspaceId: string; presetId: string }): Promise<PluginPresetMetadata>
  list(input: { workspaceId: string }): Promise<{ items: PluginSessionMetadata[]; revision: number }>
  get(input: { workspaceId: string; sessionId: string }): Promise<PluginSessionMetadata>
  create(input: { workspaceId: string; presetId?: string; title?: string; runtime?: 'claude' | 'pi'; expectedRevision: number; confirmationId?: string }): Promise<PluginSessionMetadata>
  configure(input: { workspaceId: string; sessionId: string; title?: string; modelId?: string; expectedRevision: number; confirmationId?: string }): Promise<PluginSessionMetadata>
  requestPreset(input: { workspaceId: string; sessionId: string; presetId: string; expectedRevision: number; confirmationId?: string }): Promise<{ sessionId: string; presetId: string; effectiveFrom: 'next_turn'; revision: number; auditEventId: string }>
  cancel(input: { workspaceId: string; sessionId: string; expectedRevision: number; confirmationId?: string }): Promise<PluginSessionMetadata>
}
export interface PluginRuntimeApi {
  resolve(input: { workspaceId: string; sessionId?: string; declaration: PluginCapabilityDeclaration; runtime: 'claude' | 'pi' }): Promise<PluginRuntimeCapabilityView>
  inject(input: { workspaceId: string; sessionId?: string; declaration: PluginCapabilityDeclaration; runtime: 'claude' | 'pi'; expectedRevision: number; confirmationId?: string }): Promise<PluginRuntimeCapabilityView>
}
export interface PluginSecretApi {
  listMetadata(input?: { providerId?: string }): Promise<{ items: PluginSecretMetadata[]; revision: number }>
  requestConfigure(input: { providerId: string; field: string; expectedRevision: number; confirmationId?: string }): Promise<PluginSecretRef>
}

export const PROFER_PLUGIN_PERMISSION_LABELS: Record<ProferPluginPermission, string> = {
  pluginStorage: '保存插件私有数据', 'window.floating': '显示全局悬浮窗口',
  'models.read': '读取模型列表（不含密钥）',
  'modelRouting.rules.write': '配置自动模型路由规则', 'models.invoke': '调用模型（产生模型用量）',
  'context.read': '读取打开插件时交给它的会话或消息', 'attachments.read': '读取你在文件选择器中指定的附件',
  'network.fetch': '请求声明的网络服务', 'agent.tools': '向 Agent 提供工具',
  'workspace.read': '读取工作区元数据', 'workspace.files.read': '读取工作区文件', 'workspace.files.write': '写入工作区文件',
  'presets.read': '读取预设元数据', 'presets.switch': '切换预设', 'sessions.read': '读取会话元数据',
  'sessions.create': '创建会话', 'sessions.configure': '配置会话', 'sessions.control': '控制会话',
  'runtime.capabilities.read': '读取运行时能力引用', 'runtime.capabilities.inject': '请求运行时能力变更',
  'secrets.readMetadata': '读取秘密元数据', 'secrets.configure': '配置秘密引用',
  'mcp.secrets.readMetadata': '读取秘密元数据', 'mcp.secrets.write': '配置秘密引用',
}
