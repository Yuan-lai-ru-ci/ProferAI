import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createAgentRunContext } from '@profer/agent-runtime'
import type {
  AgentRuntimeEvent,
  AgentRuntimePreparedContext,
  BackgroundTaskPort,
  AgentRuntimePorts,
  CredentialPort,
  EventPort,
  FilePort,
  CommandExecutionPort,
  CommandExecutionRequest,
  PermissionPort,
  PreviewPort,
  ResourcePort,
  RuntimeCredentialResult,
  RuntimeResources,
  SessionPort,
  ToolAssemblyPort,
  ProcessRegistrationPort,
} from '@profer/agent-runtime'
import type { AgentRuntime, AgentSessionMeta, AgentSendInput, SDKMessage, AgentStreamPayload, ProferPermissionMode } from '@profer/shared'
import { resolveAgentRuntimeChannelConflict } from '@profer/shared'
import type { SessionStore } from '@profer/session-store'
import { createElectronSessionStore } from './session-store-host'
import { appendSDKMessages, enqueueSDKMessages, getAgentSessionMessages, getAgentSessionMeta, getAgentSessionSDKMessages, updateAgentSessionMeta, lockAgentSessionRuntime, resolveAgentSessionWriteLayout } from './agent-session-manager'
import { resolveRuntimeCredentials } from './agent-runtime-credentials'
import { getChannelById } from './channel-manager'
import { getWorkspaceMcpConfig, getWorkspaceSkills, getAgentWorkspace, readWorkspaceProfile } from './agent-workspace-manager'
import { prepareRuntimeSkills } from './global-skill-manager'
import { prepareAgentSkillRouting } from './skill-runtime-routing'
import { buildSkillCatalog } from './skill-routing'
import { collectAttachedDirectories, collectProductArtifactDirectories } from './agent-directory-utils'
import { agentSessionVisualizationsDir } from './config-paths'
import { agentFilePreviewSessionManager } from './agent-file-preview-session'
import { piBackgroundTaskManager } from './pi-background-task-manager'
import { createElectronPermissionPort } from './agent-runtime-permission-port'
import { agentRuntimePolicyRuns, filterPolicyMcpResources, filterPolicySkills } from './agent-runtime-policy-snapshot'
import { buildRuntimeTurnUserPrompt } from './agent-runtime-turn-prompt'
import { selectAgentPromptMode, type AgentPromptMode } from './agent-prompt-mode'
import {
  BUILTIN_MCP_UNAVAILABLE_LOG_PREFIX,
  builtinMcpPlanInputFromContext,
  createElectronBuiltinMcpInjectionPort,
  runBuiltinMcpInjection,
  type BuiltinMcpInjectionContext,
} from './agent-runtime-mcp-injection'
import { injectGlobalMemoryTools } from './global-memory-agent-tools'
import {
  PRODUCT_MCP_UNAVAILABLE_LOG_PREFIX,
  composeBrowserAllowedRoots,
  composeImageOutputAllowedRoots,
  composePreviewAllowedRoots,
  createElectronProductMcpInjectionPort,
  productMcpPlanInputFromContext,
  runProductMcpInjection,
  type ProductMcpHostCapabilities,
  type ProductMcpInjectionContext,
  type ProductRootInputs,
} from './agent-runtime-product-mcp-injection'
import {
  clearPendingPresetChange,
  evaluateAgentPresetOperationIntents,
  getPendingPresetChange,
  isPresetChangeCancellation,
  isPresetChangeConfirmation,
  type AgentPresetOperationSource,
  type PendingPresetChange,
} from './agent-preset-operations'
import {
  hasAgentSessionProjectionPublisher,
  publishAgentSessionProjection,
} from './agent-session-ui-projection-publisher'
import { buildRunCompletedProjection, resolveRuntimeTerminalFields } from './agent-runtime-terminal-projection'
import { createElectronQueryPreparationPort } from './agent-query-preparation-port'
import { createElectronProviderQueryPreparation } from './agent-runtime-provider-preparation'
import { registerPendingPiRuntimeProcess, registerPiRuntimeProcessShell } from './runtime-process-registry'
export { createElectronPermissionPort } from './agent-runtime-permission-port'
import type { AgentEventBus } from './agent-event-bus'
import type { ExecutionService } from './execution-service'
import type { PermissionRequest, AskUserRequest, ExitPlanModeRequest } from '@profer/shared'

export interface ElectronAgentHostOptions {
  eventBus?: AgentEventBus
  backgroundTasks?: BackgroundTaskPort
  execution?: ExecutionService
  toolAssembly?: ToolAssemblyPort
  preview?: PreviewPort
  permission?: {
    canUseTool(input: {
      sessionId: string
      toolName: string
      input: unknown
      signal?: AbortSignal
    }): Promise<'allow' | 'deny' | 'ask'> | 'allow' | 'deny' | 'ask'
    askUser?(input: unknown): Promise<unknown>
    exitPlan?(input: unknown): Promise<unknown>
  }
  files?: FilePort
  processLifecycle?: import('@profer/agent-runtime').ProcessLifecyclePort
  processRegistration?: ProcessRegistrationPort
  queryPreparation?: import('@profer/agent-runtime').AgentRuntimeQueryPreparationPort
  providerQueryPreparation?: import('@profer/agent-runtime').AgentRuntimeProviderQueryPreparationPort
  /**
   * 覆盖产品 MCP 服务器（B8）所需的宿主资源（测试 / 特殊宿主）。
   *
   * 只覆盖**资源**，不覆盖规则：服务器启用条件仍由 `planProductMcpServers` 唯一决定。
   * 缺省使用 Electron 默认实现（预览端口 / 事件广播 / 真实生图探测 / 真实计划模式注册表）。
   */
  productCapabilityDeps?: ElectronProductMcpCapabilityDeps
  /**
   * Pi 内置工具装配的**原始构建器**（`buildPiBuiltinTools(sdk, ctx)` 的形状）。
   *
   * 为什么与 `toolAssembly` 分开（B8-Pi）：宿主是「本机到底能提供哪些产品能力」的唯一决定者
   * （`createElectronProductMcpCapabilities`），而 Pi 的产品工具（本地图片 / AI 生图 / 皮肤 /
   * 可视化 / 正式文件预览 / 受管浏览器）全部从装配 context 读授权根与回调。传原始构建器时，
   * 宿主用**同一份**能力提供器把产品字段投影进装配 context；传成品端口（`toolAssembly`）时宿主
   * 原样透传，不引入第二份投影（测试 / 特殊宿主）。
   */
  toolAssemblyBuild?: (sdk: unknown, context: unknown) => Promise<{ tools: readonly unknown[]; collaborationAvailable?: boolean }>
}
function toRuntimeCredentialResult(result: Awaited<ReturnType<typeof resolveRuntimeCredentials>>): RuntimeCredentialResult {
  if (!result.ok) return result
  return result
}

/** Pi 工具装配端口的宿主资源注入点（B8-Pi）。 */
export interface ElectronToolAssemblyPortOptions {
  /**
   * 产品能力提供器（与 `createElectronResourcePort` 用**同一个**）：提供时把 Pi 装配 context 缺的
   * 产品字段补齐（授权根 / 可视化回调 / 预览回调）。不提供则原样透传（不猜宿主资源）。
   */
  productCapabilities?: ElectronProductMcpCapabilityProvider
}

export function createElectronToolAssemblyPort(
  build: (sdk: unknown, context: unknown) => Promise<{ tools: readonly unknown[]; collaborationAvailable?: boolean }>,
  options: ElectronToolAssemblyPortOptions = {},
): ToolAssemblyPort {
  const productCapabilities = options.productCapabilities
  return {
    async build(input) {
      const context = productCapabilities
        ? await withPiProductToolAssemblyFields(input.context, productCapabilities)
        : input.context
      return build(input.sdk, context)
    },
  }
}

export function createElectronPreviewPort(
  events: EventPort,
  manager = agentFilePreviewSessionManager,
): PreviewPort {
  return {
    open(event) {
      return manager.waitUntilReady(event, (previewEvent) => {
        events.emit(event.sessionId, { kind: 'profer_event', event: previewEvent })
      })
    },
    inspect(request) {
      return manager.inspect(request, (previewEvent) => {
        events.emit(request.sessionId, { kind: 'profer_event', event: previewEvent })
      })
    },
  }
}

export function createElectronSessionPort(): SessionPort {
  return {
    getMeta(sessionId): AgentSessionMeta | undefined {
      return getAgentSessionMeta(sessionId)
    },
    appendMessages(sessionId, messages): undefined {
      appendSDKMessages(sessionId, [...messages])
    },
    enqueueMessages(sessionId, messages): void {
      enqueueSDKMessages(sessionId, [...messages])
    },
    updateMeta(sessionId, patch): undefined {
      updateAgentSessionMeta(sessionId, patch)
    },
    getMessages(sessionId): readonly SDKMessage[] {
      return getAgentSessionSDKMessages(sessionId)
    },
    lockRuntime(sessionId, runtime) {
      const locked = lockAgentSessionRuntime(sessionId, runtime)
      // IR-D3：锁定内核后广播会话投影（与旧编排层同一时机）。
      // 旧链在 `agent-orchestrator.ts` 锁完立即 emit `session_projection`；新路径此前只写 meta，
      // 桌面内核切换器因此可被误用。这里补上同一投影，headless / remote / automation 也得到与旧链
      // 一致的广播面。发布器未接线（单测 / 非 Electron 宿主）时不广播，不把缺省状态当成错误。
      if (hasAgentSessionProjectionPublisher()) publishAgentSessionProjection(locked)
      return locked
    },
    getAgentMessages(sessionId) {
      return getAgentSessionMessages(sessionId)
    },
  }
}

export function createElectronProcessRegistrationPort(): ProcessRegistrationPort {
  return {
    registerPending(input) {
      const record = registerPendingPiRuntimeProcess(input.sessionId, input.command, input.cwd, input.launcher)
      return record ? { id: record.id, startTime: record.startTime } : undefined
    },
    registerShell(input) {
      const record = registerPiRuntimeProcessShell(input.sessionId, input.command, input.cwd, input.pid, input.launcher)
      return record ? { id: record.id, startTime: record.startTime } : undefined
    },
  }
}

export function createElectronCommandPort(execution: ExecutionService): CommandExecutionPort {
  return {
    execute(request) {
      return execution.execute(request)
    },
    cancel(handleId) {
      return execution.cancel(handleId)
    },
    get(handleId) {
      return execution.get(handleId)
    },
  }
}

export function createElectronCredentialPort(): CredentialPort {
  return {
    async resolve(input): Promise<RuntimeCredentialResult> {
      if (!input.channelId) throw new Error('运行时凭据解析缺少 channelId')
      const channel = getChannelById(input.channelId)
      if (!channel) throw new Error(`渠道不存在: ${input.channelId}`)
      return toRuntimeCredentialResult(await resolveRuntimeCredentials(channel, input.runtime))
    },
  }
}

/**
 * 一轮运行的宿主侧事实（内置 MCP 注入需要，但它们不在 `ResourceRequest` / `AgentSessionMeta` 上）。
 * 与策略快照同一模式：入口写、`load()` 按 sessionId 读、run 结束清理。
 */
export interface AgentRuntimeRunFacts {
  /** Ledger 准入后写入的真实业务 Run；query 构造阶段不生成。 */
  sourceRunId?: string
  triggeredBy?: AgentPresetOperationSource
  userMessage?: string
  /**
   * 运行级附加目录（旧链 `input.additionalDirectories`）。
   *
   * 产品服务器的授权根需要它（旧链 `collectAttachedDirectories({ extraDirs: additionalDirectories, … })`），
   * 而 `ResourceRequest` 上没有这个字段。写入点是 `createElectronAgentRuntimeQuery`（每个 runtime run 必经），
   * 因此不需要改 runtime 公共契约。
   */
  additionalDirectories?: readonly string[]
  /**
   * 显式权限模式覆盖（旧链 `input.permissionModeOverride`）。
   * 旧链把它透传给 collaboration 注入上下文；这里同源传递，不放宽也不收紧。
   */
  permissionModeOverride?: ProferPermissionMode
  /**
   * 本轮提示词模式（`light` = 无上下文的新会话短问候）。
   *
   * 资源端口需要它：旧链在 light 下不加载任何 MCP / Skill，新链同一判据，
   * 否则一句「你好」会拉起全部 MCP 服务器。
   */
  promptMode?: AgentPromptMode
}

const agentRuntimeRunFacts = new Map<string, AgentRuntimeRunFacts>()

export function setAgentRuntimeRunFacts(sessionId: string, facts: AgentRuntimeRunFacts): void {
  agentRuntimeRunFacts.set(sessionId, facts)
}

/** 合并写入（入口已写过 `triggeredBy` / `userMessage`，运行级事实在 query 构造时补齐）。 */
export function mergeAgentRuntimeRunFacts(sessionId: string, facts: AgentRuntimeRunFacts): void {
  agentRuntimeRunFacts.set(sessionId, { ...(agentRuntimeRunFacts.get(sessionId) ?? {}), ...facts })
}

/**
 * 活跃 runtime 运行表（按 sessionId）。
 *
 * 用途：产品服务器的公布门禁需要旧链 `stoppedBySessions` / `activeSessions` 等价的「本轮是否已取消」判定，
 * 而新路径的协调器把它收在私有 `active` Map 里。这里只记「本轮 runtime 是否还在跑」，
 * 由 host event port 在 `runtime_started` / `runtime_finished` 上唯一维护（两者是同一份真实运行生命周期）。
 * 它不承担并发互斥（那是 `AgentRunOwnershipRegistry` 的职责），只是一个可观察的运行态快照。
 */
const activeRuntimeRuns = new Set<string>()

function markRuntimeRunStarted(sessionId: string): void {
  activeRuntimeRuns.add(sessionId)
}

function markRuntimeRunFinished(sessionId: string): void {
  activeRuntimeRuns.delete(sessionId)
}

/** 该 session 当前是否有 runtime 运行在本宿主上。 */
export function isRuntimeRunActive(sessionId: string): boolean {
  return activeRuntimeRuns.has(sessionId)
}

export function getAgentRuntimeRunFacts(sessionId: string): AgentRuntimeRunFacts | undefined {
  return agentRuntimeRunFacts.get(sessionId)
}

export function clearAgentRuntimeRunFacts(sessionId: string): void {
  agentRuntimeRunFacts.delete(sessionId)
}

/** 内置 MCP 注入端口（注入器懒加载，工厂本身零副作用）。 */
const builtinMcpInjectionPort = createElectronBuiltinMcpInjectionPort()

/** 产品 MCP 注入端口（B8；注入器懒加载，工厂本身零副作用）。 */
const productMcpInjectionPort = createElectronProductMcpInjectionPort()

/** 资源端口的宿主资源注入点（缺省 = 不提供产品能力，逐条记为 `capability-missing`）。 */
export interface ElectronResourcePortOptions {
  /**
   * 产品 MCP 服务器所需的宿主能力提供器（按运行解析）。
   *
   * 由**宿主**决定提供哪些资源：`createElectronAgentHost` 会注入 Electron 实现；
   * 不传则所有产品服务器按「该能力不可用」处理（既不静默跳过也不伪装成已注入）。
   */
  productCapabilities?: ElectronProductMcpCapabilityProvider
}

/**
 * 产品内置 MCP 注入（GAP-4）。
 *
 * 仅在**本轮有冻结策略快照**时执行：没有快照就不猜（不注册任何内置服务器），
 * 与「策略缺失不得静默放行」同一原则。单条注入失败按「能力不可用」记录，不阻断本轮。
 *
 * 行为差异（已记录）：新路径目前没有提示词模式概念，一律按 `standard` 注入；旧链在 `light`
 * （无上下文的新会话短问候）下整块跳过。二者都不放宽权限（工具仍受权限端口管辖）。
 */
export async function loadBuiltinMcpResources(
  sessionId: string,
  meta: AgentSessionMeta | undefined,
  workspaceSlug: string | undefined,
  port: import('./agent-runtime-mcp-injection').BuiltinMcpInjectionPort = builtinMcpInjectionPort,
): Promise<Array<Record<string, unknown>>> {
  const snapshot = agentRuntimePolicyRuns.getForRun(sessionId)
  if (!snapshot) return []

  const facts = agentRuntimeRunFacts.get(sessionId) ?? {}
  const userMessage = facts.userMessage ?? ''
  const presetOperationSource: AgentPresetOperationSource = facts.triggeredBy ?? 'user'
  const pendingPresetChange = getPendingPresetChange(sessionId)
  const userConfirmedPresetChange = presetOperationSource === 'user'
    && pendingPresetChange !== undefined
    && isPresetChangeConfirmation(userMessage)
  if (presetOperationSource === 'user' && pendingPresetChange && isPresetChangeCancellation(userMessage)) {
    clearPendingPresetChange(sessionId)
  }

  const context: BuiltinMcpInjectionContext = {
    sessionId,
    channelId: meta?.channelId ?? '',
    ...(meta?.modelId ? { modelId: meta.modelId } : {}),
    ...(meta?.workspaceId ? { workspaceId: meta.workspaceId } : {}),
    ...(workspaceSlug ? { workspaceSlug } : {}),
    runtime: meta?.agentRuntime ?? 'claude',
    ...(facts.sourceRunId ? { sourceRunId: facts.sourceRunId } : {}),
    triggeredBy: presetOperationSource,
    // 委派继承本轮冻结的有效权限模式，下一轮的预设修改不影响当前输入。
    permissionModeOverride: snapshot.policy.permissionMode,
    ...(snapshot.policy.disabledTools ? { disabledTools: [...snapshot.policy.disabledTools] } : {}),
    preset: {
      source: presetOperationSource,
      allowedOperations: presetOperationSource === 'user'
        ? [...evaluateAgentPresetOperationIntents(userMessage), ...(userConfirmedPresetChange ? ['commit_change' as const] : [])]
        : [],
      currentPresetReference: snapshot.presetReference,
      ...(userMessage ? { userMessage } : {}),
      ...(userConfirmedPresetChange && pendingPresetChange ? { pendingChange: pendingPresetChange } : {}),
    },
    // GAP-6：Goal 回调面未下沉，新路径不注入 goal（缺省即不注入，语义与旧链一致）。
  }

  const builtinMcpServers: Record<string, Record<string, unknown>> = {}
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  const outcome = await runBuiltinMcpInjection(port, {
    context,
    mcpServers: builtinMcpServers,
    sdk,
    planInput: builtinMcpPlanInputFromContext(context, 'standard', snapshot.policy.disabledToolGroups),
  })
  if (!snapshot.policy.disabledToolGroups.includes('memory')) {
    try {
      await injectGlobalMemoryTools(sdk, builtinMcpServers, snapshot.policy.disabledTools ? [...snapshot.policy.disabledTools] : undefined)
    } catch (error) {
      console.warn(`${BUILTIN_MCP_UNAVAILABLE_LOG_PREFIX}: ${JSON.stringify({ id: 'global-memory', reason: 'injector-failed', detail: error instanceof Error ? error.message : String(error) })}`)
    }
  }
  if (outcome.unavailable.length > 0) {
    console.warn(`${BUILTIN_MCP_UNAVAILABLE_LOG_PREFIX}: ${JSON.stringify(outcome.unavailable)}`)
  }
  return Object.entries(builtinMcpServers).map(([name, config]) => ({ name, ...config }))
}

/**
 * 新 runtime 链的会话写入布局解析（唯一入口）。
 *
 * 规则：
 * 1. 宿主已解析的 `storageDir` 优先（桌面 / headless 入口或 Pi 装配 context 已经给出时）；
 * 2. 否则用 `resolveAgentSessionWriteLayout(workspaceSlug, sessionId)` 取真相源；
 * 3. 无工作区或布局解析失败（project rootPath 缺失 / 索引不可用）时返回 `undefined`，
 *    调用方回落旧行为（cwd 语义），**绝不**猜一个写入落点。
 *
 * managed 下 `storageDir === cwd`，`plansDir = cwd/.context/plan`，因此旧行为零变化。
 */
export interface RuntimeSessionWriteLayoutInput {
  sessionId: string
  /** 已解析的会话存储根（优先）。 */
  storageDir?: string
  workspaceSlug?: string
}

export interface RuntimeSessionWriteLayout {
  storageDir: string
  /** 计划文件白名单目录（`<storageDir>/.context/plan`）。 */
  plansDir: string
}

export function resolveRuntimeSessionWriteLayout(
  input: RuntimeSessionWriteLayoutInput,
): RuntimeSessionWriteLayout | undefined {
  const explicit = input.storageDir?.trim()
  if (explicit) return { storageDir: explicit, plansDir: join(explicit, '.context', 'plan') }
  if (!input.workspaceSlug) return undefined
  try {
    const layout = resolveAgentSessionWriteLayout(input.workspaceSlug, input.sessionId)
    return { storageDir: layout.storageDir, plansDir: layout.plansDir }
  } catch {
    // 工作区根缺失 / 索引不可用：不创建目录、不猜路径，交给调用方回落旧行为。
    return undefined
  }
}

/**
 * 产品 MCP 服务器（B8）需要的宿主资源。
 *
 * 定位：`createElectronResourcePort` 只负责「读一轮资源并组装」，**「本机到底能提供哪些产品能力」
 * 由这里唯一决定**（与内置 7 服务器端口分开，因为两者需要的资源类型不同：前者只要策略事实，
 * 后者要预览端口 / 可视化目录 / 受授权图片根 / 剪贴板 / 受管浏览器）。
 *
 * 缺省原则：拿不到的能力就是**不提供**（键缺失）。执行器会把该服务器逐条记为 `capability-missing`，
 * 既不会静默跳过，也不会把「没有能力」当成「已注入」。
 */
export interface ElectronProductMcpCapabilityInput {
  sessionId: string
  workspaceId?: string
  workspaceSlug?: string
  cwd?: string
  /** 已解析的会话存储根（优先）；缺省时按 `workspaceSlug + sessionId` 从会话写入布局取。 */
  storageDir?: string
  /** 运行来源（受管浏览器的 `executionSource`）。 */
  triggeredBy?: AgentPresetOperationSource
  /** 运行级附加目录（旧链 `input.additionalDirectories`）。 */
  additionalDirectories?: readonly string[]
}

export type ElectronProductMcpCapabilityProvider = (
  input: ElectronProductMcpCapabilityInput,
) => ProductMcpHostCapabilities | Promise<ProductMcpHostCapabilities>

export interface ElectronProductMcpCapabilityDeps {
  /** 事件出口：可视化 / 生图更新广播（旧链 `eventPort.emit`）。缺失时相关能力不提供。 */
  events?: { emit(sessionId: string, payload: AgentStreamPayload): void }
  /** 会话可见文件预览端口（GAP-B8：`agent-preview` 的 open/inspect 回调）。 */
  preview?: PreviewPort
  /** AI 生图可用性探测；缺省懒加载真实实现（`isAgentGptImageAvailable`）。 */
  isGptImageAvailable?: () => boolean | Promise<boolean>
  /** 本轮 runtime 是否仍在运行；缺省读本模块的活跃运行表。 */
  isRuntimeRunActive?: (sessionId: string) => boolean
  /** 计划模式是否生效；缺省懒加载真实控制器注册表。 */
  isPlanModeActive?: (sessionId: string) => boolean
}

/** 旧链 `previewAllowedRoots` / `browserAllowedRoots` 的原始目录采集（组合规则在注入模块里唯一实现）。 */
function collectProductRootInputs(
  input: ElectronProductMcpCapabilityInput,
  storageDir: string | undefined,
): ProductRootInputs {
  return {
    ...(input.cwd ? { agentCwd: input.cwd } : {}),
    ...(storageDir ? { storageDir } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.workspaceSlug ? { workspaceSlug: input.workspaceSlug } : {}),
    attachedDirectories: collectAttachedDirectories({
      ...(input.additionalDirectories ? { extraDirs: [...input.additionalDirectories] } : {}),
      sessionMeta: getAgentSessionMeta(input.sessionId),
      ...(input.workspaceSlug ? { workspaceSlug: input.workspaceSlug } : {}),
    }),
    productArtifactDirectories: collectProductArtifactDirectories(),
  }
}

/**
 * Electron 宿主的默认能力提供器。
 *
 * 构造本身零副作用（重模块均为调用期动态 import），因此可以在模块级创建。
 */
export function createElectronProductMcpCapabilities(
  deps: ElectronProductMcpCapabilityDeps = {},
): ElectronProductMcpCapabilityProvider {
  const isGptImageAvailable = deps.isGptImageAvailable
    ?? (async (): Promise<boolean> => {
      const { isAgentGptImageAvailable } = await import('./agent-gpt-image-tools')
      return isAgentGptImageAvailable()
    })
  const runActive = deps.isRuntimeRunActive ?? isRuntimeRunActive
  // 计划模式注册表懒加载（只在真的要提供可视化能力时才拉入；构造本身零副作用）。
  let planModeRegistry: Promise<typeof import('./agent-runtime-plan-mode')> | undefined

  return async (input) => {
    const capabilities: ProductMcpHostCapabilities = {}
    // 会话写入布局（唯一真相源）：project 下生图产物/记录必须落中央 storageDir，
    // 不得用 cwd（项目根）拼路径。解析失败时不猜：回落调用方缺省（cwd 语义）。
    const sessionWriteLayout = resolveRuntimeSessionWriteLayout({
      sessionId: input.sessionId,
      ...(input.storageDir ? { storageDir: input.storageDir } : {}),
      ...(input.workspaceSlug ? { workspaceSlug: input.workspaceSlug } : {}),
    })
    const storageDir = sessionWriteLayout?.storageDir
    const roots = collectProductRootInputs(input, storageDir)
    const previewAllowedRoots = composePreviewAllowedRoots(roots)

    // 会话可见文件预览：宿主注入了 PreviewPort 才有（无预览端口 ⇒ agent-preview 记为能力不可用）。
    if (deps.preview) {
      const preview = deps.preview
      capabilities['file-preview'] = {
        allowedRoots: previewAllowedRoots,
        open: event => preview.open(event),
        inspect: request => preview.inspect(request),
      }
    }

    // 会话内可视化：记录目录 + 更新广播 + 公布门禁三者齐备才提供。
    if (deps.events && input.cwd && input.workspaceSlug) {
      const events = deps.events
      const { sessionId } = input
      const registry = deps.isPlanModeActive ? undefined : await (planModeRegistry ??= import('./agent-runtime-plan-mode'))
      const isPlanModeActive = deps.isPlanModeActive
        ?? ((id: string) => registry?.getAgentRuntimePlanMode(id)?.isPlanActive() ?? false)
      capabilities.visualization = {
        storageDir: agentSessionVisualizationsDir(sessionId),
        allowedRoots: previewAllowedRoots,
        onUpdate: (record) => events.emit(sessionId, {
          kind: 'profer_event',
          event: { type: 'visualization_updated', sessionId, record },
        }),
        // 与旧链同序同义：先查「本轮是否已取消」，再查计划模式。
        assertCanPresent: () => {
          if (!runActive(sessionId)) throw new Error('本轮已取消，不能公布可视化')
          if (isPlanModeActive(sessionId)) throw new Error('计划模式不能公布可视化；请先完成计划审批')
        },
      }
    }

    // 受工作区授权的图片输出根：旧链 `workspaceSlug && agentCwd ? previewAllowedRoots : []`。
    // 新链额外把 storageDir 列为授权根（project 下生成图/记录在那里）。
    const imageOutputRoots = composeImageOutputAllowedRoots(roots)
    if (imageOutputRoots.length > 0) {
      capabilities['image-output-roots'] = {
        allowedRoots: imageOutputRoots,
        // 生图产物/记录与皮肤参考图的写入根；managed 下等于 cwd，旧行为不变。
        ...(storageDir ? { storageDir } : {}),
      }
      if (deps.events) {
        const events = deps.events
        const { sessionId } = input
        capabilities['ai-image-generation'] = {
          isGptImageAvailable,
          onGenerationUpdate: (record) => events.emit(sessionId, {
            kind: 'profer_event',
            event: { type: 'image_generation_updated', sessionId, record },
          }),
        }
      }
    }

    // 系统剪贴板：Electron 主进程总是提供；headless 宿主（无 Electron）不提供。
    capabilities.clipboard = true

    // 受管浏览器：控制器是模块单例，这里只需要授权根。
    capabilities.browser = { allowedRoots: composeBrowserAllowedRoots(roots) }

    return capabilities
  }
}

/**
 * 产品能力 → Pi 工具装配 context 的产品字段（B8-Pi）。
 *
 * 旧链事实源：`agent-orchestrator.ts` 的 Pi 装配块（`this.buildPiBuiltinTools(piSdk, { … })`）里
 * 逐条传的 `allowedRoots` / `visualizationStorageDir` / `onVisualizationUpdate` /
 * `assertCanPresentVisualization` / `onPreviewRequest` / `onPreviewInspectRequest`。
 *
 * 这里**只做投影**：授权根组合、公布门禁、预览端口、事件投影全部由能力表（`capabilities`）唯一提供，
 * 因此不会产生第二份规则，也不会出现第二个预览通道。
 */
export function projectPiProductToolAssemblyFields(
  capabilities: ProductMcpHostCapabilities,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  // 旧链 Pi 只有一个 `allowedRoots`，值是 `browserAllowedRoots`（不是 `previewAllowedRoots`）：
  // send_local_image / generate_image / create_skin / present_visualization / open_file_preview /
  // 受管浏览器控制器共用它。
  if (capabilities.browser) fields.allowedRoots = [...capabilities.browser.allowedRoots]
  const visualization = capabilities.visualization
  if (visualization) {
    // 「有工作区 + 有会话工作目录」这个条件由能力表唯一判定（缺条件 ⇒ 不提供 ⇒ 可视化工具不注册）。
    fields.visualizationStorageDir = visualization.storageDir
    fields.onVisualizationUpdate = visualization.onUpdate
    fields.assertCanPresentVisualization = visualization.assertCanPresent
  }
  const preview = capabilities['file-preview']
  if (preview) {
    fields.onPreviewRequest = preview.open
    fields.onPreviewInspectRequest = preview.inspect
  }
  // 会话私有存储根：Pi 的生图/本地图片/皮肤工具从装配 context 读 `storageDir`，
  // project 下缺它会把产物写进项目根（旧链在 `buildPiBuiltinTools` 里直接传同一个值）。
  const imageOutput = capabilities['image-output-roots']
  if (imageOutput?.storageDir) fields.storageDir = imageOutput.storageDir
  return fields
}

/**
 * 把宿主产品能力投影进 Pi 工具装配 context。
 *
 * 只补**缺失**键：调用方已经给出的字段（旧链自己的装配 context / 特殊宿主 / 测试）一律不动。
 * 因此旧链路径上的结果与投影前**同对象同值**（严格 no-op），不改变「关闭开关即回旧链」的等价性。
 *
 * 拿不到会话身份或拿不到能力时不猜：对应字段保持缺失（Pi 侧按「不提供」处理，不静默放行）。
 */
export async function withPiProductToolAssemblyFields(
  context: unknown,
  productCapabilities: ElectronProductMcpCapabilityProvider,
): Promise<unknown> {
  if (!context || typeof context !== 'object') return context
  const base = context as Record<string, unknown>
  const sessionId = typeof base.sessionId === 'string' && base.sessionId.length > 0 ? base.sessionId : undefined
  if (!sessionId) return context

  // 运行级事实与资源端口同源（`additionalDirectories` 不在 PiBuiltinToolsContext 上，
  // 它与授权根组合直接相关，因此从宿主 per-run 注册表读，不在装配侧重算）。
  const facts = agentRuntimeRunFacts.get(sessionId) ?? {}
  const triggeredBy = facts.triggeredBy
    ?? (typeof base.triggeredBy === 'string' ? base.triggeredBy as AgentPresetOperationSource : undefined)
  const capabilities = await productCapabilities({
    sessionId,
    ...(typeof base.workspaceId === 'string' ? { workspaceId: base.workspaceId } : {}),
    ...(typeof base.workspaceSlug === 'string' ? { workspaceSlug: base.workspaceSlug } : {}),
    ...(typeof base.agentCwd === 'string' ? { cwd: base.agentCwd } : {}),
    ...(typeof base.storageDir === 'string' && base.storageDir.trim() ? { storageDir: base.storageDir } : {}),
    ...(triggeredBy ? { triggeredBy } : {}),
    ...(facts.additionalDirectories ? { additionalDirectories: facts.additionalDirectories } : {}),
  })

  const additions = Object.entries(projectPiProductToolAssemblyFields(capabilities))
    .filter(([key]) => base[key] === undefined)
  if (additions.length === 0) return context
  return { ...base, ...Object.fromEntries(additions) }
}

/**
 * 产品 MCP 注入（B8）。
 *
 * 与内置注入同样的保守原则：**没有冻结策略快照就不猜**。
 * 没有快照意味着不知道预设禁用了哪些工具组，注入就等于放宽门禁，所以直接不注入。
 *
 * 已记录的行为差异：新路径目前没有 `light` 提示词模式，一律按 `standard`；
 * 旧链在 `light`（无上下文的新会话短问候）下整块跳过。两者都不放宽权限。
 */
export async function loadProductMcpResources(
  sessionId: string,
  meta: AgentSessionMeta | undefined,
  cwd: string | undefined,
  workspaceSlug: string | undefined,
  capabilities: ProductMcpHostCapabilities,
  port: import('./agent-runtime-product-mcp-injection').ProductMcpInjectionPort = productMcpInjectionPort,
): Promise<Array<Record<string, unknown>>> {
  const snapshot = agentRuntimePolicyRuns.getForRun(sessionId)
  if (!snapshot) return []

  const facts = agentRuntimeRunFacts.get(sessionId) ?? {}
  const context: ProductMcpInjectionContext = {
    sessionId,
    ...(meta?.workspaceId ? { workspaceId: meta.workspaceId } : {}),
    ...(workspaceSlug ? { workspaceSlug } : {}),
    ...(cwd ? { agentCwd: cwd } : {}),
    ...(facts.triggeredBy ? { triggeredBy: facts.triggeredBy } : {}),
    ...(snapshot.policy.disabledTools ? { disabledTools: [...snapshot.policy.disabledTools] } : {}),
  }

  const productMcpServers: Record<string, Record<string, unknown>> = {}
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  const outcome = await runProductMcpInjection(port, {
    context,
    mcpServers: productMcpServers,
    sdk,
    planInput: productMcpPlanInputFromContext(
      context,
      meta?.agentRuntime ?? 'claude',
      'standard',
      snapshot.policy.disabledToolGroups,
      snapshot.policy.pptCapabilityActive,
    ),
    capabilities,
  })
  if (outcome.unavailable.length > 0) {
    console.warn(`${PRODUCT_MCP_UNAVAILABLE_LOG_PREFIX}: ${JSON.stringify(outcome.unavailable)}`)
  }
  return Object.entries(productMcpServers).map(([name, config]) => ({ name, ...config }))
}

export function createElectronResourcePort(options: ElectronResourcePortOptions = {}): ResourcePort {
  const capabilityProvider = options.productCapabilities
  return {
    async load(input): Promise<RuntimeResources> {
      // light：无上下文的新会话短问候不加载任何 MCP / Skill（旧链同一判据）。
      // 否则一句「你好」会拉起全部 MCP 服务器，首字延迟全花在没人用的工具上。
      if (agentRuntimeRunFacts.get(input.sessionId)?.promptMode === 'light') return {}
      const meta = getAgentSessionMeta(input.sessionId)
      const workspaceSlug = input.workspaceSlug
        ?? (meta?.workspaceId ? getAgentWorkspace(meta.workspaceId)?.slug : undefined)
      const facts = agentRuntimeRunFacts.get(input.sessionId) ?? {}
      // 会话写入布局：project 下产品能力（生图产物/记录、皮肤参考图）必须拿 storageDir，
      // 不能只给 cwd（项目根），否则一旦生图就污染用户仓库。
      const sessionWriteLayout = resolveRuntimeSessionWriteLayout({
        sessionId: input.sessionId,
        ...(workspaceSlug ? { workspaceSlug } : {}),
      })
      // GAP-4 / B8：内置与产品 MCP 注入都与「有没有工作区」无关（旧链同样无条件跑），
      // 因此先于「无工作区」的早退执行；外部 MCP 才依赖工作区配置。
      const builtinMcpResources = await loadBuiltinMcpResources(input.sessionId, meta, workspaceSlug)
      const capabilities = capabilityProvider
        ? await capabilityProvider({
            sessionId: input.sessionId,
            ...(input.workspaceId ?? meta?.workspaceId ? { workspaceId: input.workspaceId ?? meta?.workspaceId } : {}),
            ...(workspaceSlug ? { workspaceSlug } : {}),
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(sessionWriteLayout ? { storageDir: sessionWriteLayout.storageDir } : {}),
            ...(facts.triggeredBy ? { triggeredBy: facts.triggeredBy } : {}),
            ...(facts.additionalDirectories ? { additionalDirectories: facts.additionalDirectories } : {}),
          })
        : undefined
      const productMcpResources = capabilities
        ? await loadProductMcpResources(input.sessionId, meta, input.cwd, workspaceSlug, capabilities)
        : []
      const injectedMcpResources = [...builtinMcpResources, ...productMcpResources]
      if (!workspaceSlug) return injectedMcpResources.length > 0 ? { mcpResources: injectedMcpResources } : {}

      const profile = readWorkspaceProfile(workspaceSlug)
      const skills = getWorkspaceSkills(workspaceSlug)
      const mcpConfig = getWorkspaceMcpConfig(workspaceSlug)
      const enabledSkills = skills.filter((skill) => skill.enabled).map((skill) => skill.slug)
      const enabledMcpResources = Object.entries(mcpConfig.servers ?? {})
        .filter(([, value]) => value.enabled)
        .map(([name, value]) => ({ name, ...value }))
      // 预设策略裁剪：与本轮已冻结的策略快照同一份规则。
      // 查不到快照（未接线 / 其他宿主）时保持现状而不猜测裁剪：禁用项由工具装配与权限端口承担，
      // 本函数只负责「白名单内的可见性」，因此缺快照不会放行任何被禁用的能力。
      const snapshot = agentRuntimePolicyRuns.getForRun(input.sessionId)
      // Pi 没有 SDK 侧 Skill 发现：catalog 必须由 Profer 提供（与旧链同一 builder）。
      // Claude 由 SDK 自己发现，旧链同样不注入 catalog。
      let skillCatalog: string | undefined
      if (meta?.agentRuntime === 'pi' && snapshot) {
        try {
          const routing = await prepareAgentSkillRouting({
            projection: prepareRuntimeSkills(workspaceSlug),
            policy: snapshot.policy,
            toolNames: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', ...enabledMcpResources.map(resource => String(resource.name ?? ''))],
          })
          skillCatalog = buildSkillCatalog(routing.snapshot) || undefined
        } catch (error) {
          // 目录是增强能力：构建失败不阻断本轮，只是模型看不到 skill 清单。
          console.warn('[Agent Runtime] Skill 目录构建失败，本轮不注入 catalog:', error)
        }
      }
      return {
        projectInstructions: profile.content ? [profile.content] : [],
        skills: snapshot ? [...filterPolicySkills(snapshot, enabledSkills)] : enabledSkills,
        mcpResources: [
          ...(snapshot ? [...filterPolicyMcpResources(snapshot, enabledMcpResources)] : enabledMcpResources),
          ...injectedMcpResources,
        ],
        ...(skillCatalog ? { skillCatalog } : {}),
      }
    },
    getMcpConfig({ workspaceSlug }) {
      return getWorkspaceMcpConfig(workspaceSlug)
    },
  }
}

export function createElectronEventBusPort(eventBus: AgentEventBus): { emit(sessionId: string, payload: AgentStreamPayload): void } {
  return { emit: (sessionId, payload) => eventBus.emit(sessionId, payload) }
}

export function createElectronEventPort(eventBus: AgentEventBus): { emit(event: AgentRuntimeEvent): void } {
  /**
   * 每会话的终态观察点。
   *
   * `runtime_finished` 只携带 outcome，而用户可见的 `run_completed` 需要
   * startedAt / resultSubtype / resultErrors。这些事实在**同一条事件流**上已经出现过
   * （`runtime_claimed` / `runtime_started` 与 `result` SDKMessage），所以这里只做「记住 + 组合」，
   * 终态判定仍由 `resolveRuntimeTerminalFields` 唯一提供，不引入第二套判据。
   *
   * 这是 remote / automation / headless 三入口 `run_completed` **字段集相同**的原因：
   * 它们看到的是同一个 host event port 的同一份映射。
   */
  const observations = new Map<string, { startedAt?: number; resultMessage?: SDKMessage }>()
  return {
    emit(event): void {
      // B8：本宿主唯一维护「本轮 runtime 是否还在跑」（产品服务器的公布门禁需要它，
      // 与旧链 `stoppedBySessions` / `activeSessions` 同义）。必须是同步先于后面所有 await 的写入。
      //
      // 运行态快照挂在**claim**上而不是 `runtime_started` 上：准备阶段（凭证 / 资源 / 工具装配）
      // 也是一轮真实 run 的存在期，只是还没有产生「用户可见的运行开始」。
      if (event.type === 'runtime_claimed' || event.type === 'runtime_started') markRuntimeRunStarted(event.sessionId)
      else if (event.type === 'runtime_finished') markRuntimeRunFinished(event.sessionId)
      // 路由键一律取事件自带的 `sessionId`，**不得**从 `event.message.session_id` 推断。
      // 后者是内核原生会话 id（Pi 的 `sdkSessionId` / Claude 的 SDK session id），与 agent 会话 id
      // 不同；`sessionWebContents` 绑定表是按 agent 会话 id 建的，用错键会让 `sdk_message`
      // 在 EventBus 转发层查不到目标而被静默丢弃 —— 实机症状是 UI 失去逐字出流，
      // 且 `result` 消息会存进错误的 observation 键，连带终态字段与刷新回放一起丢。
      const sessionId =
        event.type === 'message' ||
        event.type === 'runtime_claimed' ||
        event.type === 'runtime_started' ||
        event.type === 'runtime_finished' ||
        event.type === 'host_event' ||
        event.type === 'stream_payload'
          ? event.sessionId
          : undefined
      if (!sessionId) return

      if (event.type === 'message') {
        if ((event.message as unknown as { type?: unknown }).type === 'result') {
          const observation = observations.get(sessionId) ?? {}
          observation.resultMessage = event.message
          observations.set(sessionId, observation)
        }
        eventBus.emit(sessionId, { kind: 'sdk_message', message: event.message })
      } else if (event.type === 'host_event') {
        eventBus.emit(sessionId, { kind: 'profer_event', event: event.event })
      } else if (event.type === 'stream_payload') {
        eventBus.emit(sessionId, event.payload)
      } else if (event.type === 'runtime_claimed') {
        // claim 只记录运行起点时刻，**不**广播 `external_run_started`：
        // 准备失败时渲染层不得看到「运行已开始」（也不得据此清未读 / 晋升 draft）。
        const observation = observations.get(sessionId) ?? {}
        observation.startedAt = event.startedAt
        observations.set(sessionId, observation)
      } else if (event.type === 'runtime_started') {
        const observation = observations.get(sessionId) ?? {}
        observation.startedAt = event.startedAt
        observations.set(sessionId, observation)
        eventBus.emit(sessionId, { kind: 'profer_event', event: { type: 'external_run_started', source: 'bridge', sessionId, startedAt: event.startedAt, title: event.title, workspaceId: event.workspaceId, modelId: event.modelId, initiator: event.initiator } })
      } else if (event.type === 'runtime_finished') {
        const observation = observations.get(sessionId)
        observations.delete(sessionId)
        // 委派取消不算「用户停止」：与旧路径 `callbacks.source !== 'delegation'` 同义。
        const fields = resolveRuntimeTerminalFields({
          outcome: event.outcome,
          ...(event.initiator === 'delegation' ? { source: 'delegation' as const } : {}),
          observation: {
            ...(observation?.startedAt !== undefined ? { startedAt: observation.startedAt } : {}),
            ...(observation?.resultMessage !== undefined ? { resultMessage: observation.resultMessage } : {}),
          },
        })
        eventBus.emit(sessionId, {
          kind: 'profer_event',
          event: {
            ...buildRunCompletedProjection(sessionId, fields),
            ...(event.title ? { title: event.title } : {}),
            ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
            ...(event.modelId ? { modelId: event.modelId } : {}),
            ...(event.initiator ? { initiator: event.initiator } : {}),
          },
        })
      }
    },
  }
}

export interface ElectronAgentRuntimeQueryOptions {
  runtime: AgentRuntime
  cwd?: string
  providerInput?: Readonly<Record<string, unknown>>
  toolAssemblyContext?: unknown
  /**
   * 原生会话 id（热启动）。缺省取 `input.runtimeSessionId`（Goal 隔离会话）。
   *
   * 新链必须显式传入会话已持久化的 `sdkSessionId`，否则每轮都是新建 provider session，
   * 历史与缓存全部重建（真机上表现为「它忘了上一轮」）。
   */
  runtimeSessionId?: string
  /** 回退后的 provider 截断点（仅在 resume 生效时有意义）。 */
  resumeSessionAt?: string
  /** 仅本轮的隐藏上下文前缀（回退 notice）；不写入用户消息、不进 UI。 */
  promptPrefix?: string
  /** 完全替换本轮 prompt（resume 失效时的恢复提示）；缺省按 automationContext/internalPrompt/userMessage 拼装。 */
  promptOverride?: string
  /**
   * 本轮的 Shadow Git 写入证据账本。
   *
   * provider 的受控写入回调（Pi 的 `onFileWrite`）在 provider 层触发，而账本属于这一轮；
   * 通过 query metadata 传下去，避免为了一个回调再引入一份会话级全局表。
   */
  shadowLedger?: import('./workspace-shadow-write-evidence').ShadowEvidenceLedger
}

/**
 * 本轮提示词模式（与旧链 `selectAgentPromptMode` 同一判据）。
 *
 * 拿不到策略快照时一律 `standard`：猜 light 会让一个真需要工具的任务丢掉 MCP 与 Skill。
 */
function resolveRuntimePromptModeForInput(input: AgentSendInput): AgentPromptMode {
  const snapshot = agentRuntimePolicyRuns.getForRun(input.sessionId)
  if (!snapshot) return 'standard'
  const meta = getAgentSessionMeta(input.sessionId)
  return selectAgentPromptMode({
    message: input.userMessage,
    hasRuntimeSession: Boolean(meta?.sdkSessionId),
    hasHistory: !meta?.sdkSessionId && (getAgentSessionMessages(input.sessionId)?.length ?? 0) > 1,
    hasAttachedResources: Boolean(meta?.attachedDirectories?.length || meta?.attachedFiles?.length),
    hasPresetInstructions: Boolean(snapshot.policy.preset.promptSections?.length),
    permissionMode: snapshot.policy.permissionMode,
    request: input,
  })
}

/** 将现有 headless 输入收敛为 runtime 可消费的中性 query；未映射的业务回调不进入 runtime。 */
export function createElectronAgentRuntimeQuery(input: AgentSendInput, options: ElectronAgentRuntimeQueryOptions): import('@profer/agent-runtime').AgentRuntimeQuery {
  // 跨内核不可绕过校验（新链）：本函数是每个 runtime run 的必经点，也是宿主唯一能拿到
  // 渠道注册表的地方。非法请求在构造 query 时就报错，不会到达 provider（不会建进程、
  // 不会写 transcript、不会广播假终态）。
  const runtimeChannelConflict = resolveAgentRuntimeChannelConflict({
    sessionRuntime: options.runtime,
    channelId: input.channelId,
    channel: input.channelId ? getChannelById(input.channelId) : undefined,
  })
  if (runtimeChannelConflict) throw new Error(runtimeChannelConflict)
  // B8：把运行级事实写进宿主侧 per-run 注册表（`setAgentRuntimeRunFacts` 已由入口写过
  // `triggeredBy` / `userMessage`，这里补齐产品服务器需要的两项）。
  // 为什么写在这里：`ResourceRequest` 上没有 `additionalDirectories` / `permissionModeOverride`，
  // 而本函数是每个 runtime run 的必经点（headless 与桌面同源），因此不需要改 runtime 公共契约。
  mergeAgentRuntimeRunFacts(input.sessionId, {
    ...(input.additionalDirectories?.length ? { additionalDirectories: [...input.additionalDirectories] } : {}),
    ...(input.permissionModeOverride ? { permissionModeOverride: input.permissionModeOverride } : {}),
  })
  // 提示词模式：与旧链同一判据（`selectAgentPromptMode`）。在这里算一次，
  // 同时给资源端口（light 不加载 MCP / Skill）与提示词装配（light 不拼动态上下文/历史）。
  const promptMode = resolveRuntimePromptModeForInput(input)
  // 只记录 light：standard 是缺省语义，写进去会让每次 standard run 的 metadata / run facts
  // 多一个恒等字段（下游按形状断言的地方会全部漂移）。
  if (promptMode === 'light') mergeAgentRuntimeRunFacts(input.sessionId, { promptMode })
  const providerInput = {
    ...(options.providerInput ?? {}),
    ...(options.resumeSessionAt ? { resumeSessionAt: options.resumeSessionAt } : {}),
    ...(input.customMcpServers ? { customMcpServers: input.customMcpServers } : {}),
    ...(input.permissionModeOverride ? { permissionMode: input.permissionModeOverride } : {}),
    ...(input.mentionedSkills ? { mentionedSkills: [...input.mentionedSkills] } : {}),
    ...(input.mentionedMcpServers ? { mentionedMcpServers: [...input.mentionedMcpServers] } : {}),
    ...(input.automationContext ? { automationContext: input.automationContext } : {}),
    ...(input.mentionedSessionIds ? { mentionedSessionIds: [...input.mentionedSessionIds] } : {}),
  }
  const basePrompt = options.promptOverride
    ?? (input.automationContext
      ? `${input.automationContext}\n\n${input.internalPrompt ?? input.userMessage}`
      : input.internalPrompt ?? input.userMessage)
  // 回退 notice 只拼进本轮 runtime prompt：persistedUserMessage 仍用原始用户输入，UI/JSONL 看不到。
  const prompt = options.promptPrefix ? `${options.promptPrefix}\n\n${basePrompt}` : basePrompt
  const runtimeSessionId = options.runtimeSessionId ?? input.runtimeSessionId
  const persistedUserMessage = input.suppressUserMessagePersistence
    ? undefined
    : {
        type: 'user' as const,
        message: { content: [{ type: 'text' as const, text: input.rawUserMessage ?? input.userMessage }] },
        parent_tool_use_id: null,
        ...(input.uuid ? { uuid: input.uuid } : {}),
        ...(input.taskReturnReferences?.length ? { _taskReturnReferences: input.taskReturnReferences.map(reference => ({ ...reference })) } : {}),
        ...(input.triggeredBy === 'goal' ? { _goalIteration: input.goalIteration ?? true } : {}),
        _createdAt: Date.now(),
      } as unknown as import('@profer/shared').SDKMessage
  return {
    sessionId: input.sessionId,
    context: createAgentRunContext(input, randomUUID),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    onRunAdmitted: admitted => {
      mergeAgentRuntimeRunFacts(admitted.sessionId, { sourceRunId: admitted.runId })
    },
    prompt,
    runtime: options.runtime,
    channelId: input.channelId,
    modelId: input.modelId,
    title: input.titleSourceText ?? input.userMessage,
    workspaceId: input.workspaceId,
    initiator: input.initiator ?? (input.triggeredBy === 'automation' ? 'automation' : input.triggeredBy === 'delegation' ? 'delegation' : input.triggeredBy === 'goal' ? 'goal' : 'external'),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(input.additionalDirectories ? { additionalDirectories: [...input.additionalDirectories] } : {}),
    ...(runtimeSessionId ? { runtimeSessionId } : {}),
    ...(input.isolatedRuntimeSession !== undefined ? { isolatedRuntimeSession: input.isolatedRuntimeSession } : {}),
    ...(options.toolAssemblyContext !== undefined ? { deferredToolAssemblyContext: options.toolAssemblyContext } : {}),
    ...(input.startedAt !== undefined || promptMode === 'light' || options.shadowLedger
      ? {
          metadata: {
            ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
            ...(promptMode === 'light' ? { promptMode } : {}),
            ...(options.shadowLedger ? { shadowLedger: options.shadowLedger } : {}),
          },
        }
      : {}),
    ...(Object.keys(providerInput).length ? { providerInput } : {}),
    ...(persistedUserMessage ? { persistedUserMessage } : {}),
  }
}

export interface ElectronAgentHost {
  ports: AgentRuntimePorts
  sessions: SessionPort
  sessionStore: SessionStore
  credentials: CredentialPort
  resources: ResourcePort
}

export function createElectronAgentHost(options: ElectronAgentHostOptions = {}): ElectronAgentHost {
  const sessions = createElectronSessionPort()
  const sessionStore = createElectronSessionStore()

  const credentials = createElectronCredentialPort()
  const events = options.eventBus ? createElectronEventBusPort(options.eventBus) : undefined
  // 预览端口只构造一次：它既是 runtime 的 ports.preview，也是产品预览能力（agent-preview）的资源。
  const preview = options.preview ?? (events ? createElectronPreviewPort(events) : undefined)
  // B8：产品服务器需要的宿主资源在**这里**决定（而非在 runtime core 或端口默认值里猜）。
  // 拿不到的能力就是「不提供」，执行器会把对应服务器逐条记为 `capability-missing`。
  // 同一份能力表同时服务于：产品 MCP 服务器注入（资源端口）与 Pi 工具装配 context 投影（B8-Pi）。
  const productCapabilities = createElectronProductMcpCapabilities({
    ...(events ? { events } : {}),
    ...(preview ? { preview } : {}),
    ...options.productCapabilityDeps,
  })
  const resources = createElectronResourcePort({ productCapabilities })
  // B8-Pi：传原始构建器时，宿主用同一份能力把产品字段（授权根 / 可视化回调 / 预览回调）
  // 投影进 Pi 装配 context；传成品端口时原样透传（测试 / 特殊宿主）。
  const toolAssembly = options.toolAssembly
    ?? (options.toolAssemblyBuild
      ? createElectronToolAssemblyPort(options.toolAssemblyBuild, { productCapabilities })
      : undefined)
  const permissions = createElectronPermissionPort({
    ...options.permission,
    // 三个来源依次看：本轮显式 override（automation/飞书/移动端）、本轮冻结的策略快照、
    // 会话元数据（用户在界面上选的值）。快照必须参与：预设未声明权限时策略解析为
    // 完全自动（默认），provider 收到的就是这个值；只看会话元数据会让没写
    // permissionMode 的历史会话与移动端会话退化成「每一步都要确认」。
    isBypassPermissions: (sessionId: string) => {
      const override = getAgentRuntimeRunFacts(sessionId)?.permissionModeOverride
      if (override) return override === 'bypassPermissions'
      const snapshot = agentRuntimePolicyRuns.getForRun(sessionId)
      if (snapshot) return snapshot.policy.permissionMode === 'bypassPermissions'
      return getAgentSessionMeta(sessionId)?.permissionMode === 'bypassPermissions'
    },
  })
  const preparationPorts = { credentials, resources, permissions, events, toolAssembly }
  const defaultPreparation = createElectronQueryPreparationPort(preparationPorts)
  const queryPreparation: NonNullable<AgentRuntimePorts['queryPreparation']> = options.queryPreparation ?? {
    async prepare(input, signal) {
      const prepared = await prepareWithScopedPermissions(input, signal)
      // 本轮用户消息侧 prompt（动态上下文 / `@` 引用 / 运行来源 / 历史回填）。
      // 写在准备阶段：动态上下文要用实际加载的 MCP 名单，历史回填要知道本轮消息尚未落盘。
      return {
        ...prepared,
        prompt: buildRuntimeTurnUserPrompt(input, {
          ...(prepared.mcpServers ? { mcpServerNames: Object.keys(prepared.mcpServers) } : {}),
          hasResume: Boolean(input.runtimeSessionId),
        }),
      }
    },
  }
  async function prepareWithScopedPermissions(
    input: Parameters<NonNullable<AgentRuntimePorts['queryPreparation']>['prepare']>[0],
    signal: AbortSignal,
  ): Promise<AgentRuntimePreparedContext> {
    const lifecycle = input.runLifecycle
    if (!lifecycle || !permissions.createCanUseTool) return defaultPreparation.prepare(input, signal)
    const scopedPermissions: PermissionPort = {
      ...permissions,
      createCanUseTool: config => async (toolName, toolInput, toolOptions) => {
        const requests = new Set<string>()
        const waiting = (requestId: string) => {
          lifecycle.wait(requestId)
          requests.add(requestId)
        }
        const callback = permissions.createCanUseTool!({
          ...config,
          sendPermissionRequest: request => {
            waiting(request.requestId)
            config.sendPermissionRequest(request)
          },
          sendAskUserRequest: request => {
            waiting(request.requestId)
            config.sendAskUserRequest?.(request)
          },
        })
        try {
          return await callback(toolName, toolInput, toolOptions)
        } finally {
          // abort 表示运行正在停止；不把取消审批伪造为继续执行。
          if (!toolOptions.signal.aborted) for (const id of requests) lifecycle.resume(id)
        }
      },
    }
    return createElectronQueryPreparationPort({ ...preparationPorts, permissions: scopedPermissions }).prepare(input, signal)
  }
  return {
    sessions,
    sessionStore,
    credentials,
    resources,
    ports: {
      sessions,
      credentials,
      resources,
      permissions,
      backgroundTasks: options.backgroundTasks ?? piBackgroundTaskManager,
      ...(options.execution ? { commands: createElectronCommandPort(options.execution) } : {}),
      ...(toolAssembly ? { toolAssembly } : {}),
      ...(preview ? { preview } : {}),
      ...(options.eventBus ? { host: createElectronEventPort(options.eventBus) } : {}),
      ...(events ? { events } : {}),
      ...(options.files ? { files: options.files } : {}),
      processLifecycle: options.processLifecycle,
      processRegistration: options.processRegistration ?? createElectronProcessRegistrationPort(),
      queryPreparation,
      providerQueryPreparation: options.providerQueryPreparation ?? createElectronProviderQueryPreparation(),
    },
  }
}

export type { AgentRuntime, AgentSessionMeta, PermissionRequest, AskUserRequest, ExitPlanModeRequest }
