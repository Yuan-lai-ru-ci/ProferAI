/**
 * agent-runtime-product-mcp-injection —— 产品「宿主能力型」MCP 服务器的注入端口（B8）。
 *
 * 背景：旧编排层在 `promptMode === 'standard'` 的第二个注入块里注册 8 个**产品服务器**
 * （visualization / agent-preview / agent-image-output / agent-gpt-image / agent-skin /
 * ppt-delivery / clipboard / browser）。新 runtime 路径此前只接线了「内置 7 个」
 * （见 `agent-runtime-mcp-injection.ts`），这 8 个仍然只在旧链注入 —— 桌面切到新链会直接丢掉它们。
 *
 * 为什么**不**把它们塞进内置 7 服务器的那个端口：
 * 这 8 个服务器各自需要不同的**宿主资源**（会话可见文件预览端口、可视化记录目录与广播、
 * 受授权图片输出根、受管浏览器根、系统剪贴板等）。内置端口的输入只有「策略事实」，
 * 一旦把宿主资源塞进去，端口契约就会被单一产品形态绑死。这里改成：
 *
 * 1. `planProductMcpServers` —— 纯决策函数，**只**吃旧链的启用条件事实
 *    （提示词模式 / runtime / 预设禁用工具组 / 工作区与会话工作目录 / PPT 能力门禁），
 *    不含任何宿主依赖，可脱离 Electron 直接跑。
 * 2. `ProductMcpHostCapabilities` —— **按资源类型**划分的能力表（会话内可视化 / 会话可见文件预览 /
 *    受授权图片输出根 / AI 生图 / 系统剪贴板 / 受管浏览器），由宿主决定提供哪些；
 *    服务器只声明自己需要哪些能力。
 * 3. `runProductMcpInjection` —— 统一执行器：缺端口、计划失败、**缺宿主能力**、单条注入失败、
 *    注入器静默无产物，全部逐条记录，**既不静默放行、也不整体失败、更不伪装成已注入**。
 *
 * 边界（刻意不做的事）：
 * - 不复制编排层的注入分支：注入函数、参数构造、顺序都来自旧链同一批模块，规则唯一来源是本文件。
 * - 不放宽任何门禁：被预设禁用的工具组在这里同样禁用（`disabledToolGroups` 是计划输入）。
 * - 不把宿主资源判定写进 runtime core 或 provider：core 只透传 `mcpResources`。
 *
 * 行为等价性由 `agent-runtime-product-mcp-injection.parity.test.ts` 用**真实旧源码切片**逐项对照
 * （比较最终注册的服务器集合与顺序，以及每个注入器收到的位置参数）。
 */

import { resolve } from 'node:path'
import type {
  AgentFilePreviewInspectRequest,
  AgentFilePreviewInspectResult,
  AgentFilePreviewReport,
  AgentImageGenerationCard,
  AgentRuntime,
  ProferEvent,
  VisualizationRecord,
} from '@profer/shared'
import type { ClaudeSdkNamespace, McpServerTable } from './agent-runtime-mcp-injection'

/**
 * 产品 MCP 服务器 id。
 *
 * 每个 id **就是**注册进 `mcpServers` / `mcpResources` 的键，逐个核对自旧链注入器
 * （注意键名与文件名不同名：`agent-preview` / `agent-image-output` / `agent-gpt-image` /
 * `agent-skin`，不是 preview / image / gpt-image / skin）。
 */
export type ProductMcpServerId =
  | 'visualization'
  | 'agent-preview'
  | 'agent-image-output'
  | 'agent-gpt-image'
  | 'agent-skin'
  | 'ppt-delivery'
  | 'clipboard'
  | 'browser'

/** 旧编排层的注入顺序（逐条一致；顺序影响 `Object.keys(mcpServers)` 与提示词里的 MCP 名单）。 */
export const PRODUCT_MCP_INJECTION_ORDER: readonly ProductMcpServerId[] = Object.freeze([
  'visualization',
  'agent-preview',
  'agent-image-output',
  'agent-gpt-image',
  'agent-skin',
  'ppt-delivery',
  'clipboard',
  'browser',
])

/** 宿主能力 id：**按资源类型**划分（不是按服务器划分），宿主按自己实际拥有的资源提供。 */
export type ProductMcpCapabilityId =
  /** 会话内可视化：记录目录 + 更新广播 + 公布门禁。 */
  | 'visualization'
  /** 会话可见文件预览：打开 / 检查回调 + 预览授权根。 */
  | 'file-preview'
  /** 受工作区授权的图片输出根（本地图片输出 / AI 生图 / 皮肤共用同一批根）。 */
  | 'image-output-roots'
  /** AI 生图：可用性探测 + 生成进度广播（本地图片输出不需要它）。 */
  | 'ai-image-generation'
  /** 系统剪贴板（Electron 主进程 clipboard）。 */
  | 'clipboard'
  /** 受管浏览器：浏览器授权根（控制器由注入器模块自身持有）。 */
  | 'browser'

/** 会话内可视化能力。 */
export interface ProductVisualizationCapability {
  /** 可视化记录存储根（旧链 `agentSessionVisualizationsDir(sessionId)`）。 */
  storageDir: string
  /** 预览授权根（旧链 `previewAllowedRoots`）。 */
  allowedRoots: readonly string[]
  /** 记录更新广播（旧链 `eventPort.emit(... visualization_updated)`）。 */
  onUpdate(record: VisualizationRecord): void
  /** 公布门禁：计划模式 / 本轮已取消（旧链 `assertCanPresentVisualization`）。 */
  assertCanPresent(): void
}

/** 会话可见文件预览能力（宿主 PreviewPort）。 */
export interface ProductFilePreviewCapability {
  /** 预览授权根（旧链 `previewAllowedRoots`）。 */
  allowedRoots: readonly string[]
  open(event: Extract<ProferEvent, { type: 'preview_requested' }>): Promise<AgentFilePreviewReport>
  inspect(request: AgentFilePreviewInspectRequest): Promise<AgentFilePreviewInspectResult>
}

/** 受工作区授权的图片输出根（旧链 `imageOutputAllowedRoots`）；本地图片输出与皮肤创作只用它。 */
export interface ProductImageOutputRootsCapability {
  allowedRoots: readonly string[]
  /**
   * 会话私有存储根（`resolveAgentSessionWriteLayout().storageDir`）。
   * 生图产物/记录与皮肤参考图的真实落点：project 下它不在 cwd 内，缺省回落到 cwd（managed 旧语义）。
   */
  storageDir?: string
}

/** AI 生图能力：可用性探测（旧链 `isAgentGptImageAvailable()`）与生成进度广播（`image_generation_updated`）。 */
export interface ProductAiImageGenerationCapability {
  /** 假值 ⇒ `agent-gpt-image` 记为 `capability-unavailable`，不注册服务器。 */
  isGptImageAvailable(): boolean | Promise<boolean>
  onGenerationUpdate(record: AgentImageGenerationCard): void
}

/** 受管浏览器能力（控制器是单例，由 `claude-browser-tools.ts` 自己持有；这里只给授权根）。 */
export interface ProductBrowserCapability {
  /** 浏览器授权根（旧链注入时现算的那份去重清单）。 */
  allowedRoots: readonly string[]
}

/**
 * 宿主能力表。
 *
 * 键是**资源类型 id**，值是宿主实际提供的资源；不提供的键 = 该能力不可用（服务器会被逐条记为
 * `capability-missing`，不会静默跳过、不会退化成「已注入」）。
 */
export interface ProductMcpHostCapabilities {
  visualization?: ProductVisualizationCapability
  'file-preview'?: ProductFilePreviewCapability
  'image-output-roots'?: ProductImageOutputRootsCapability
  'ai-image-generation'?: ProductAiImageGenerationCapability
  /** 无负载能力：宿主存在即代表本机可以用 Electron 剪贴板。 */
  clipboard?: true
  browser?: ProductBrowserCapability
}

/**
 * 每个服务器需要的宿主能力（**结构性**要求，与宿主无关，因此可以静态断言）。
 *
 * `ppt-delivery` 只需要纯 JS 的视觉计划 / 交付审计服务，不需要宿主资源，所以是空集 ——
 * 它的门禁（`pptCapabilityActive`）本身就在计划输入里。
 */
export const PRODUCT_MCP_REQUIRED_CAPABILITIES: Readonly<Record<ProductMcpServerId, readonly ProductMcpCapabilityId[]>> = Object.freeze({
  visualization: Object.freeze(['visualization'] as const),
  'agent-preview': Object.freeze(['file-preview'] as const),
  'agent-image-output': Object.freeze(['image-output-roots'] as const),
  'agent-gpt-image': Object.freeze(['image-output-roots', 'ai-image-generation'] as const),
  'agent-skin': Object.freeze(['image-output-roots'] as const),
  'ppt-delivery': Object.freeze([] as const),
  clipboard: Object.freeze(['clipboard'] as const),
  browser: Object.freeze(['browser'] as const),
})

/**
 * 计划输入：只包含**决定是否注入**的事实（逐条来自旧链源码）。
 *
 * 刻意不含宿主能力：能力缺失是「宿主提供不了」，必须与「策略不允许」区分开记录。
 */
export interface ProductMcpPlanInput {
  /** 提示词模式；旧链整块注入都在 `promptMode === 'standard'` 分支里。 */
  promptMode: 'light' | 'standard'
  runtime: AgentRuntime
  /** 预设解析出的禁用工具组（`EffectiveAgentPresetPolicy.disabledToolGroups`）。 */
  disabledToolGroups: readonly string[]
  /** 是否存在工作区（旧链 `workspaceSlug`）。 */
  hasWorkspace: boolean
  /** 是否存在会话工作目录（旧链 `agentCwd`；旧链恒为真，新路径无工作区时为 undefined）。 */
  hasSessionCwd: boolean
  /** 宿主已判定的 PPT 能力门禁（`EffectiveAgentPresetPolicy.pptCapabilityActive`）。 */
  pptCapabilityActive: boolean
}

/** 该服务器**不在计划内**的原因（策略结果，不是失败）。 */
export type ProductMcpSkipReason =
  /** `promptMode === 'light'`：旧链整块跳过产品服务器注入。 */
  | 'prompt-mode-light'
  /** 预设禁用了对应工具组（preview / image / clipboard / browser）。 */
  | 'tool-group-disabled'
  /** 该服务器只对特定 runtime 可用（除 image-output / ppt-delivery 外都只注入 claude）。 */
  | 'runtime-unsupported'
  /** 本轮上下文缺少该服务器必需的事实（工作区 / 会话工作目录 / PPT 能力门禁）。 */
  | 'context-missing'

/** 计划内但最终**不可用**的原因（失败或宿主能力缺失，必须记录）。 */
export type ProductMcpUnavailableReason =
  /** 宿主没有提供注入端口实现。 */
  | 'port-missing'
  /** 端口的计划函数抛错，本轮无法判断该注入什么。 */
  | 'plan-failed'
  /** 宿主没有提供该服务器需要的宿主能力（例如没有预览端口 / 没有受管浏览器）。 */
  | 'capability-missing'
  /** 宿主提供了能力但该能力自己的可用性探测为假（例如 AI 生图未启用）。 */
  | 'capability-unavailable'
  /** 单个注入器抛错；其余服务器不受影响。 */
  | 'injector-failed'
  /** 注入器正常返回但没有注册任何服务器（例如缺少必需上下文时的提前 return）。 */
  | 'injector-noop'

/** 单个产品服务器的计划条目。 */
export interface ProductMcpPlanEntry {
  id: ProductMcpServerId
  /** 策略是否允许注册（只表达策略结论；宿主能力是否具备见 outcome）。 */
  enabled: boolean
  reason: 'enabled' | ProductMcpSkipReason
}

/**
 * 纯决策函数：本轮应该注册哪些产品 MCP 服务器。
 *
 * 规则与旧编排层逐条对齐（`agent-orchestrator.ts` 第二个 `promptMode === 'standard'` 块）：
 * - `visualization`：standard 且 claude 且**有工作区且有会话工作目录**且未禁用 `preview`；
 * - `agent-preview`：standard 且 claude 且未禁用 `preview`（**不要求**工作区）；
 * - `agent-image-output`：standard 且「有会话工作目录 + 图片输出根非空」且未禁用 `image`；
 * - `agent-gpt-image` / `agent-skin`：同上再叠加 claude（嵌套在 image 块内）；
 * - `ppt-delivery`：standard 且 `pptCapabilityActive`（无 runtime 门禁、无工具组门禁）；
 * - `clipboard` / `browser`：standard 且 claude 且未禁用对应工具组。
 *
 * `imageOutputAllowedRoots` 的等价性：旧链
 * `imageOutputAllowedRoots = workspaceSlug && agentCwd ? previewAllowedRoots : []`，
 * 而 `previewAllowedRoots` 在这个分支下必定含 `agentCwd`，因此「根非空」⇔「有工作区且有会话工作目录」。
 * 该等价性由 parity 测试用真实旧源码切片复核（不是只比较两个同名布尔）。
 */
export function planProductMcpServers(input: ProductMcpPlanInput): readonly ProductMcpPlanEntry[] {
  const standard = input.promptMode === 'standard'
  const disabled = new Set(input.disabledToolGroups)
  const claude = input.runtime === 'claude'
  const hasImageOutputRoots = input.hasWorkspace && input.hasSessionCwd
  const imageBlock = input.hasSessionCwd && hasImageOutputRoots && !disabled.has('image')

  const decide = (
    id: ProductMcpServerId,
    enabled: boolean,
    reason: ProductMcpSkipReason,
  ): ProductMcpPlanEntry => ({ id, enabled, reason: enabled ? 'enabled' : reason })

  /** runtime 门禁 + 工具组门禁 + 上下文的统一理由（顺序与旧链 `if` 的书写顺序一致）。 */
  const reasonOf = (group: string, needsContext: boolean): ProductMcpSkipReason => {
    if (!standard) return 'prompt-mode-light'
    if (!claude) return 'runtime-unsupported'
    if (disabled.has(group)) return 'tool-group-disabled'
    return needsContext ? 'context-missing' : 'tool-group-disabled'
  }

  const entries: Record<ProductMcpServerId, ProductMcpPlanEntry> = {
    visualization: decide(
      'visualization',
      standard && claude && input.hasWorkspace && input.hasSessionCwd && !disabled.has('preview'),
      reasonOf('preview', true),
    ),
    'agent-preview': decide(
      'agent-preview',
      standard && claude && !disabled.has('preview'),
      reasonOf('preview', false),
    ),
    'agent-image-output': decide(
      'agent-image-output',
      standard && imageBlock,
      !standard
        ? 'prompt-mode-light'
        : disabled.has('image') ? 'tool-group-disabled' : 'context-missing',
    ),
    'agent-gpt-image': decide(
      'agent-gpt-image',
      standard && imageBlock && claude,
      !standard
        ? 'prompt-mode-light'
        : !claude ? 'runtime-unsupported' : disabled.has('image') ? 'tool-group-disabled' : 'context-missing',
    ),
    'agent-skin': decide(
      'agent-skin',
      standard && imageBlock && claude,
      !standard
        ? 'prompt-mode-light'
        : !claude ? 'runtime-unsupported' : disabled.has('image') ? 'tool-group-disabled' : 'context-missing',
    ),
    'ppt-delivery': decide(
      'ppt-delivery',
      standard && input.pptCapabilityActive,
      !standard ? 'prompt-mode-light' : 'context-missing',
    ),
    clipboard: decide(
      'clipboard',
      standard && claude && !disabled.has('clipboard'),
      reasonOf('clipboard', false),
    ),
    browser: decide(
      'browser',
      standard && claude && !disabled.has('browser'),
      reasonOf('browser', false),
    ),
  }

  return Object.freeze(PRODUCT_MCP_INJECTION_ORDER.map(id => entries[id]))
}

/**
 * 授权根组合的原始输入（逐个来自旧链注入块里的局部量）。
 *
 * 目录**采集**由宿主负责（`collectAttachedDirectories` / `collectProductArtifactDirectories`）；
 * 本模块只负责把采集结果按旧链的**组合规则**拼成注入器真正收到的根列表，
 * 这样「组合规则」可以被逐条对照（而不是把两段拼接收在各调用点里）。
 */
export interface ProductRootInputs {
  /** 会话工作目录（旧链 `agentCwd`）。 */
  agentCwd?: string
  workspaceId?: string
  workspaceSlug?: string
  /** 会话私有存储根（`resolveAgentSessionWriteLayout().storageDir`）；缺省表示按 cwd 语义处理。 */
  storageDir?: string
  /** 旧链 `collectAttachedDirectories({ extraDirs: additionalDirectories, sessionMeta, workspaceSlug })` 的结果。 */
  attachedDirectories: readonly string[]
  /** 旧链 `collectProductArtifactDirectories()` 的结果。 */
  productArtifactDirectories: readonly string[]
}

/** 旧链 `previewAllowedRoots`：会话工作目录（有工作区时）+ 附加目录 + 产品产物目录。 */
export function composePreviewAllowedRoots(input: ProductRootInputs): string[] {
  return [
    ...(input.workspaceSlug && input.agentCwd ? [input.agentCwd] : []),
    ...input.attachedDirectories,
    ...input.productArtifactDirectories,
  ]
}

/**
 * 旧链 `imageOutputAllowedRoots`：仅当有工作区且会话工作目录存在时才非空。
 *
 * 在旧链根列表之后追加会话存储根（`storageDir`）：project 下生图产物与记录都落在那里，
 * 不把它列为授权根会让「生成图 → 皮肤壁纸 / 参考图」这类后续读取被判定越权。
 * managed 下 `storageDir === agentCwd`，与已有的首根重合，数组逐字保持不变（旧行为零变化）。
 */
export function composeImageOutputAllowedRoots(input: ProductRootInputs): string[] {
  if (!input.workspaceSlug || !input.agentCwd) return []
  const roots = composePreviewAllowedRoots(input)
  const storageDir = input.storageDir?.trim()
  if (!storageDir) return roots
  const alreadyCovered = roots.some(root => resolve(root) === resolve(storageDir))
  return alreadyCovered ? roots : [...roots, storageDir]
}

/**
 * 旧链 `browserAllowedRoots`：`workspaceId ? agentCwd : undefined` 打头，其余与预览根一致，最后去重。
 *
 * 注意与预览根的区别：预览根看 `workspaceSlug`，浏览器根看 `workspaceId`，空字符串会被过滤。
 */
export function composeBrowserAllowedRoots(input: ProductRootInputs): string[] {
  return [...new Set([
    input.workspaceId ? input.agentCwd : undefined,
    ...input.attachedDirectories,
    ...input.productArtifactDirectories,
  ].filter((root): root is string => typeof root === 'string' && root.length > 0))]
}

/** 本轮的运行上下文（决定项之外的「构造参数」都在这里）。 */
export interface ProductMcpInjectionContext {
  sessionId: string
  workspaceId?: string
  workspaceSlug?: string
  /** 会话工作目录（旧链 `agentCwd`）；缺省时按「无会话工作目录」处理。 */
  agentCwd?: string
  /** 运行来源；同时是受管浏览器的 `executionSource`（旧链 `input.triggeredBy ?? 'user'`）。 */
  triggeredBy?: 'user' | 'automation' | 'delegation' | 'goal'
  /** 预设禁用的单工具短名。 */
  disabledTools?: readonly string[]
}

/** 由上下文推导计划输入（把「构造参数」与「决定项」分开，避免调用方各自解释规则）。 */
export function productMcpPlanInputFromContext(
  context: ProductMcpInjectionContext,
  runtime: AgentRuntime,
  promptMode: 'light' | 'standard',
  disabledToolGroups: readonly string[],
  pptCapabilityActive: boolean,
): ProductMcpPlanInput {
  return {
    promptMode,
    runtime,
    disabledToolGroups,
    hasWorkspace: typeof context.workspaceSlug === 'string' && context.workspaceSlug.length > 0,
    hasSessionCwd: typeof context.agentCwd === 'string' && context.agentCwd.length > 0,
    pptCapabilityActive,
  }
}

/** 单轮注入请求。 */
export interface ProductMcpInjectionRequest {
  context: ProductMcpInjectionContext
  /** 待写入的 MCP 服务器表（就地修改，与旧链同一张表）。 */
  mcpServers: McpServerTable
  /** Claude Agent SDK 命名空间；由宿主加载（旧链同样在 provider 前加载）。 */
  sdk: ClaudeSdkNamespace
  /** 计划输入；由 `productMcpPlanInputFromContext` 推导或测试直接给出。 */
  planInput: ProductMcpPlanInput
  /** 宿主提供的能力表（缺键 = 该能力不可用）。 */
  capabilities: ProductMcpHostCapabilities
}

/**
 * 注入端口契约。
 *
 * `plan` 决定注册哪些服务器，`inject` 负责把单个服务器写进 `mcpServers`。
 * 端口实现不得自行吞掉失败（抛错由执行器统一记录），也不得改动其他服务器的产物。
 */
export interface ProductMcpInjectionPort {
  plan(input: ProductMcpPlanInput): readonly ProductMcpPlanEntry[]
  inject(entry: ProductMcpPlanEntry, request: ProductMcpInjectionRequest): Promise<void>
}

/** 单轮注入结果：计划内 / 未启用 / 计划内但不可用，三者互斥且可逐条审计。 */
export interface ProductMcpInjectionOutcome {
  /** 宿主是否提供注入端口。 */
  portAvailable: boolean
  /** 实际注册进 `mcpServers` 的服务器（按注入顺序）。 */
  injected: readonly ProductMcpServerId[]
  /** 策略不允许、因此未注册的服务器。 */
  skipped: readonly { id: ProductMcpServerId; reason: ProductMcpSkipReason }[]
  /** 策略允许、但最终不可用的服务器（必须记录，不得静默当作已注入）。 */
  unavailable: readonly { id: ProductMcpServerId; reason: ProductMcpUnavailableReason; detail?: string }[]
}

/** 能力不可用时的日志前缀，保证「该能力不可用」在宿主日志里可被检索。 */
export const PRODUCT_MCP_UNAVAILABLE_LOG_PREFIX = '[Agent 产品 MCP] 能力不可用'

/** 注入器调用签名：`sdk` / `mcpServers` 是公共前两位，其余位置参数由参数构造器给出。 */
export type ProductMcpInjector = (
  sdk: ClaudeSdkNamespace,
  mcpServers: McpServerTable,
  ...args: readonly unknown[]
) => Promise<void>

/**
 * 统一执行器。
 *
 * 语义（逐条对应 B8 要求 3）：
 * - 端口缺失：`portAvailable=false`，计划内的服务器全部记为 `port-missing`；不抛错、不静默。
 * - 计划抛错：逐条记为 `plan-failed`，不整体失败。
 * - **缺宿主能力**：逐条记为 `capability-missing`（带能力 id），不调用注入器、不落任何服务器。
 * - 单个注入器抛错：只把该条记为 `injector-failed`，其余继续。
 * - 注入器无产物：记为 `injector-noop`。
 *
 * 判定「是否真的注册了」用的是 `mcpServers` 的实际键，而不是注入器返回值，
 * 因此「看起来调用了、实际没注册」不会被当成成功。
 */
export async function runProductMcpInjection(
  port: ProductMcpInjectionPort | undefined,
  request: ProductMcpInjectionRequest,
): Promise<ProductMcpInjectionOutcome> {
  if (!port) {
    const fallbackPlan = planProductMcpServers(request.planInput)
    return {
      portAvailable: false,
      injected: [],
      skipped: skippedOf(fallbackPlan),
      unavailable: fallbackPlan
        .filter(entry => entry.enabled)
        .map(entry => ({ id: entry.id, reason: 'port-missing' as const })),
    }
  }

  let plan: readonly ProductMcpPlanEntry[]
  try {
    plan = port.plan(request.planInput)
  } catch (error) {
    return {
      portAvailable: true,
      injected: [],
      skipped: [],
      unavailable: PRODUCT_MCP_INJECTION_ORDER.map(id => ({
        id,
        reason: 'plan-failed' as const,
        detail: describeError(error),
      })),
    }
  }

  const injected: ProductMcpServerId[] = []
  const unavailable: Array<{ id: ProductMcpServerId; reason: ProductMcpUnavailableReason; detail?: string }> = []

  for (const entry of plan) {
    if (!entry.enabled) continue
    const missing = missingCapabilities(entry.id, request.capabilities)
    if (missing.length > 0) {
      unavailable.push({ id: entry.id, reason: 'capability-missing', detail: missing.join(',') })
      continue
    }
    try {
      await port.inject(entry, request)
    } catch (error) {
      if (error instanceof ProductMcpCapabilityUnavailableError) {
        unavailable.push({ id: entry.id, reason: 'capability-unavailable', detail: error.detail })
        continue
      }
      unavailable.push({ id: entry.id, reason: 'injector-failed', detail: describeError(error) })
      continue
    }
    if (Object.prototype.hasOwnProperty.call(request.mcpServers, entry.id)) {
      injected.push(entry.id)
    } else {
      unavailable.push({ id: entry.id, reason: 'injector-noop' })
    }
  }

  return { portAvailable: true, injected, skipped: skippedOf(plan), unavailable }
}

/** 该服务器缺少的宿主能力（按 `PRODUCT_MCP_REQUIRED_CAPABILITIES` 的声明顺序）。 */
export function missingCapabilities(
  id: ProductMcpServerId,
  capabilities: ProductMcpHostCapabilities,
): readonly ProductMcpCapabilityId[] {
  return PRODUCT_MCP_REQUIRED_CAPABILITIES[id].filter(capability => !capabilities[capability])
}

/** 宿主能力探测为假时抛出（执行器映射为 `capability-unavailable`）。 */
export class ProductMcpCapabilityUnavailableError extends Error {
  readonly detail: string
  constructor(detail: string) {
    super(`产品 MCP 宿主能力不可用: ${detail}`)
    this.name = 'ProductMcpCapabilityUnavailableError'
    this.detail = detail
  }
}

/** 宿主缺少必需能力时抛出（直接调用参数构造器的调用方使用；执行器会提前拦截）。 */
export class ProductMcpCapabilityMissingError extends Error {
  readonly capability: ProductMcpCapabilityId
  constructor(capability: ProductMcpCapabilityId) {
    super(`产品 MCP 缺少宿主能力: ${capability}`)
    this.name = 'ProductMcpCapabilityMissingError'
    this.capability = capability
  }
}

function skippedOf(plan: readonly ProductMcpPlanEntry[]): readonly { id: ProductMcpServerId; reason: ProductMcpSkipReason }[] {
  return plan
    .filter((entry): entry is ProductMcpPlanEntry & { reason: ProductMcpSkipReason } => !entry.enabled)
    .map(entry => ({ id: entry.id, reason: entry.reason }))
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function requireCapability<K extends ProductMcpCapabilityId>(
  capabilities: ProductMcpHostCapabilities,
  id: K,
): NonNullable<ProductMcpHostCapabilities[K]> {
  const capability = capabilities[id]
  if (!capability) throw new ProductMcpCapabilityMissingError(id)
  return capability as NonNullable<ProductMcpHostCapabilities[K]>
}

function disabledToolsOf(context: ProductMcpInjectionContext): string[] | undefined {
  return context.disabledTools !== undefined ? [...context.disabledTools] : undefined
}

/**
 * 构造某个产品注入器的位置参数（= 真实注入函数签名去掉前两位）。
 *
 * 逐条与旧编排层传入的对象一致（旧链字段是**无条件**给出的，undefined 也占位）：
 * - `visualization`：`[{sessionId, agentCwd, storageDir, allowedRoots, onUpdate, assertCanPresent}, disabledTools]`
 * - `agent-preview`：`[{sessionId, agentCwd, allowedRoots, onRequest, onInspectRequest}, disabledTools]`
 * - `agent-image-output`：`[{agentCwd, storageDir, allowedRoots}, disabledTools]`
 * - `agent-gpt-image`：`[{sessionId, agentCwd, storageDir, allowedRoots, onGenerationUpdate}, disabledTools]`
 * - `agent-skin`：`[{agentCwd, storageDir, allowedRoots, workspaceSlug}, disabledTools]`
 * - `ppt-delivery`：`[disabledTools]`（没有上下文参数）
 * - `clipboard`：`[disabledTools]`
 * - `browser`：`[{sessionId, workspaceId, agentCwd, allowedRoots, executionSource, disabledTools}]`（`disabledTools` 是上下文字段）
 *
 * `storageDir` 取自 `image-output-roots` 能力（宿主解析的会话私有存储根）：project 下生图产物/记录
 * 与皮肤参考图都在那里，旧链的 `agentSessionStorageDir` 同源。
 *
 * 这是宿主适配层与测试取证**共用**的构造器：测试可以比较真实注入函数收到的参数，
 * 而不是比较一份适配层副本。
 */
export async function buildProductMcpInjectorArgs(
  id: ProductMcpServerId,
  request: ProductMcpInjectionRequest,
): Promise<readonly unknown[]> {
  const ctx = request.context
  const disabledTools = disabledToolsOf(ctx)
  const capabilities = request.capabilities

  switch (id) {
    case 'visualization': {
      const capability = requireCapability(capabilities, 'visualization')
      return [
        {
          sessionId: ctx.sessionId,
          agentCwd: ctx.agentCwd,
          storageDir: capability.storageDir,
          allowedRoots: [...capability.allowedRoots],
          onUpdate: capability.onUpdate,
          assertCanPresent: capability.assertCanPresent,
        },
        disabledTools,
      ]
    }
    case 'agent-preview': {
      const capability = requireCapability(capabilities, 'file-preview')
      return [
        {
          sessionId: ctx.sessionId,
          // 旧链：`agentCwd: workspaceSlug ? agentCwd : ''` —— 无工作区时显式给空串（不把 homedir 当预览根）。
          // 保持与旧链同形：工作区存在但会话工作目录缺失时也是 `undefined`（生产不可达；
          // 新路径里 cwd 随 workspaceSlug 一同出现，见 `buildRuntimeHeadlessRunContext`）。
          agentCwd: ctx.workspaceSlug ? ctx.agentCwd : '',
          allowedRoots: [...capability.allowedRoots],
          onRequest: capability.open,
          onInspectRequest: capability.inspect,
        },
        disabledTools,
      ]
    }
    case 'agent-image-output': {
      const capability = requireCapability(capabilities, 'image-output-roots')
      return [
        {
          agentCwd: ctx.agentCwd,
          // project 下生图产物必须落 storageDir（不在项目根）；managed 下两者相等。
          storageDir: capability.storageDir,
          allowedRoots: [...capability.allowedRoots],
        },
        disabledTools,
      ]
    }
    case 'agent-gpt-image': {
      const roots = requireCapability(capabilities, 'image-output-roots')
      const generation = requireCapability(capabilities, 'ai-image-generation')
      // 旧链在调用注入器之前先做可用性探测；不通过即按「该能力不可用」记录，不注册服务器。
      if (!(await generation.isGptImageAvailable())) {
        throw new ProductMcpCapabilityUnavailableError('ai-image-generation')
      }
      return [
        {
          sessionId: ctx.sessionId,
          agentCwd: ctx.agentCwd,
          // 生图产物/记录与「上一张生成图」的查询都跟会话存储目录（project 下不在项目根）。
          storageDir: roots.storageDir,
          allowedRoots: [...roots.allowedRoots],
          onGenerationUpdate: generation.onGenerationUpdate,
        },
        disabledTools,
      ]
    }
    case 'agent-skin': {
      const capability = requireCapability(capabilities, 'image-output-roots')
      return [
        {
          agentCwd: ctx.agentCwd,
          // 皮肤壁纸/缩略图常直接引用本会话生成图：参考图授权必须包含 storageDir。
          storageDir: capability.storageDir,
          allowedRoots: [...capability.allowedRoots],
          workspaceSlug: ctx.workspaceSlug,
        },
        disabledTools,
      ]
    }
    case 'ppt-delivery':
      return [disabledTools]
    case 'clipboard':
      requireCapability(capabilities, 'clipboard')
      return [disabledTools]
    case 'browser': {
      const capability = requireCapability(capabilities, 'browser')
      return [
        {
          sessionId: ctx.sessionId,
          workspaceId: ctx.workspaceId,
          agentCwd: ctx.agentCwd,
          allowedRoots: [...capability.allowedRoots],
          executionSource: ctx.triggeredBy ?? 'user',
          disabledTools,
        },
      ]
    }
    default: {
      const exhaustive: never = id
      throw new Error(`未知产品 MCP 服务器: ${String(exhaustive)}`)
    }
  }
}

/**
 * 生产注入器（懒加载）。
 *
 * 为什么必须懒加载而不是模块顶层 import：
 * 1. `agent-orchestrator → agent-collaboration-tools → agent-service → agent-orchestrator` 是已知模块环
 *    （GAP-7 E3），在循环入口处静态 import 产品模块会触发 TDZ；
 * 2. 这些模块持有 Electron 单例（受管浏览器控制器、预览会话管理器、剪贴板），
 *    「只 import 而不调用」也必须零副作用，否则测试无法直接加载本模块。
 * 调用期动态 import 在生产上总是安全的（入口已完整求值）。
 */
async function loadDefaultProductInjectors(): Promise<Record<ProductMcpServerId, ProductMcpInjector>> {
  const [visualization, preview, imageOutput, gptImage, skin, pptDelivery, clipboard, browser] = await Promise.all([
    import('./agent-visualization-tools'),
    import('./agent-preview-tools'),
    import('./agent-image-output-tools'),
    import('./agent-gpt-image-tools'),
    import('./agent-skin-tools'),
    import('./ppt-delivery-agent-tools'),
    import('./claude-clipboard-tools'),
    import('./claude-browser-tools'),
  ])

  return {
    visualization: (sdk, mcpServers, ...args) => visualization.injectVisualizationMcpServer(
      sdk,
      mcpServers,
      args[0] as Parameters<typeof visualization.injectVisualizationMcpServer>[2],
      args[1] as Parameters<typeof visualization.injectVisualizationMcpServer>[3],
    ),
    'agent-preview': (sdk, mcpServers, ...args) => preview.injectAgentPreviewMcpServer(
      sdk,
      mcpServers,
      args[0] as Parameters<typeof preview.injectAgentPreviewMcpServer>[2],
      args[1] as Parameters<typeof preview.injectAgentPreviewMcpServer>[3],
    ),
    'agent-image-output': (sdk, mcpServers, ...args) => imageOutput.injectAgentImageOutputMcpServer(
      sdk,
      mcpServers,
      args[0] as Parameters<typeof imageOutput.injectAgentImageOutputMcpServer>[2],
      args[1] as Parameters<typeof imageOutput.injectAgentImageOutputMcpServer>[3],
    ),
    'agent-gpt-image': (sdk, mcpServers, ...args) => gptImage.injectAgentGptImageMcpServer(
      sdk,
      mcpServers,
      args[0] as Parameters<typeof gptImage.injectAgentGptImageMcpServer>[2],
      args[1] as Parameters<typeof gptImage.injectAgentGptImageMcpServer>[3],
    ),
    'agent-skin': (sdk, mcpServers, ...args) => skin.injectAgentSkinMcpServer(
      sdk,
      mcpServers,
      args[0] as Parameters<typeof skin.injectAgentSkinMcpServer>[2],
      args[1] as Parameters<typeof skin.injectAgentSkinMcpServer>[3],
    ),
    'ppt-delivery': (sdk, mcpServers, ...args) => pptDelivery.injectPptDeliveryMcpServer(
      sdk,
      mcpServers,
      args[0] as Parameters<typeof pptDelivery.injectPptDeliveryMcpServer>[2],
    ),
    clipboard: (sdk, mcpServers, ...args) => clipboard.injectClaudeClipboardMcpServer(
      sdk,
      mcpServers,
      args[0] as Parameters<typeof clipboard.injectClaudeClipboardMcpServer>[2],
    ),
    browser: (sdk, mcpServers, ...args) => browser.injectClaudeBrowserMcpServer(
      sdk,
      mcpServers,
      args[0] as Parameters<typeof browser.injectClaudeBrowserMcpServer>[2],
    ),
  }
}

export interface ElectronProductMcpInjectionDeps {
  /** 覆盖默认注入器（测试取证 / 宿主替换）。8 条全部提供时不会加载生产注入器模块。 */
  injectors?: Partial<Record<ProductMcpServerId, ProductMcpInjector>>
}

/**
 * Electron 宿主的默认端口实现。
 *
 * - `plan` 直接复用纯函数 `planProductMcpServers`（规则唯一来源，宿主不得再写一份条件）；
 * - `inject` 用 `buildProductMcpInjectorArgs` 构造参数后调用注入器；
 * - 注入器模块懒加载（见 `loadDefaultProductInjectors`），因此本工厂本身零副作用。
 */
export function createElectronProductMcpInjectionPort(
  deps: ElectronProductMcpInjectionDeps = {},
): ProductMcpInjectionPort {
  let injectorsPromise: Promise<Record<ProductMcpServerId, ProductMcpInjector>> | undefined
  const loadInjectors = (): Promise<Record<ProductMcpServerId, ProductMcpInjector>> => {
    injectorsPromise ??= (async () => {
      const overrides = deps.injectors ?? {}
      const missing = PRODUCT_MCP_INJECTION_ORDER.filter(id => !overrides[id])
      const defaults = missing.length > 0 ? await loadDefaultProductInjectors() : undefined
      return Object.fromEntries(
        PRODUCT_MCP_INJECTION_ORDER.map(id => [id, overrides[id] ?? defaults?.[id]]),
      ) as Record<ProductMcpServerId, ProductMcpInjector>
    })()
    return injectorsPromise
  }

  return {
    plan: input => planProductMcpServers(input),
    async inject(entry, request) {
      const injector = (await loadInjectors())[entry.id]
      if (!injector) throw new Error(`产品 MCP 服务器缺少注入器: ${entry.id}`)
      const args = await buildProductMcpInjectorArgs(entry.id, request)
      await injector(request.sdk, request.mcpServers, ...args)
    },
  }
}
