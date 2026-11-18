import type { AgentRuntimePreparedContext, AgentRuntimeQueryPreparationPort } from './contract'
import type { CredentialPort, ResourcePort, PermissionPort, ToolAssemblyPort, EventPort } from './ports'

export interface AgentQueryPreparationOptions {
  credentials?: CredentialPort
  resources?: ResourcePort
  permissions?: PermissionPort
  toolAssembly?: ToolAssemblyPort
  events?: EventPort
}

/** 准备阶段失败的阶段标识（provider 尚未启动）。 */
export type AgentRuntimePreparationPhase =
  | 'credentials'
  | 'resources'
  | 'tool_assembly'
  | 'permission_host'
  | 'persistence'
  /** 进入 `.catch` 但未携带阶段信息的失败（事件端口 / 回调异常等）。 */
  | 'unknown'

/**
 * 准备阶段失败：凭证解析 / 资源加载 / 工具装配 / 权限宿主缺失等 **provider 启动前** 的失败。
 *
 * 为什么需要具名错误：
 * - 宿主必须把「准备失败」与「运行失败」分开处理（前者 provider 没有参与，后者已经跑过一轮）；
 * - 凭证类失败还要被翻译成产品文案（旧路径的 TypedError 气泡 + `interruption_record`）；
 * - `code` 携带结构化失败码（凭证失败时即 CredentialPort 的 code），
 *   宿主不得靠匹配 message 文本判断。
 */
export class AgentRuntimePreparationError extends Error {
  readonly kind = 'preparation'

  constructor(
    message: string,
    readonly code: string,
    readonly phase: AgentRuntimePreparationPhase,
  ) {
    super(message)
    this.name = 'AgentRuntimePreparationError'
  }
}

/** 结构化准备失败信息；经 `AgentRuntimeCallbacks.onPreparationFailure` 交给宿主。 */
export interface AgentRuntimePreparationFailure {
  phase: AgentRuntimePreparationPhase
  /** 结构化失败码（凭证失败时为 `token_expired` / `api_key_decrypt_failed`）。 */
  code?: string
  message: string
}

/** 复用已解析的本轮快照，仅经宿主 ports 补齐缺失字段。 */
export function createAgentQueryPreparationPort(ports: AgentQueryPreparationOptions): AgentRuntimeQueryPreparationPort {
  return {
    async prepare(input, signal): Promise<AgentRuntimePreparedContext> {
      signal.throwIfAborted()
      const prepared = { ...input.prepared }
      if (!prepared.credentials && input.channelId && ports.credentials) {
        const result = await ports.credentials.resolve({ sessionId: input.sessionId, runtime: input.runtime, channelId: input.channelId, modelId: input.modelId })
        signal.throwIfAborted()
        if (!result.ok) {
          throw new AgentRuntimePreparationError(
            `Credential resolution failed: ${result.code}`,
            result.code,
            'credentials',
          )
        }
        prepared.credentials = result.credentials
      }
      if (!prepared.resources && ports.resources) {
        prepared.resources = await ports.resources.load({ sessionId: input.sessionId, cwd: input.cwd })
        signal.throwIfAborted()
      }
      if (!prepared.systemPrompt && prepared.resources) {
        const instructions = prepared.resources.projectInstructions?.filter(Boolean) ?? []
        if (instructions.length > 0) prepared.systemPrompt = instructions.join('\n\n')
      }
      if (prepared.skills === undefined && prepared.resources?.skills !== undefined) {
        prepared.skills = [...prepared.resources.skills]
      }
      if (prepared.mcpServers === undefined && prepared.resources?.mcpResources !== undefined) {
        prepared.mcpServers = Object.fromEntries(prepared.resources.mcpResources.flatMap(resource => {
          if (!resource || typeof resource !== 'object') return []
          const record = resource as Record<string, unknown>
          const name = typeof record.name === 'string' ? record.name : undefined
          if (!name) return []
          const { name: _name, ...config } = record
          return [[name, config]]
        }))
      }
      if (input.deferredToolAssemblyContext !== undefined) {
        if (!ports.toolAssembly) {
          throw new AgentRuntimePreparationError('Agent tool assembly host is not configured', 'tool_assembly_host_missing', 'tool_assembly')
        }
        prepared.deferredToolAssembly = {
          build: async (sdk) => ports.toolAssembly!.build({ sdk, context: input.deferredToolAssemblyContext }),
        }
      }
      if (!prepared.canUseTool && ports.permissions?.createCanUseTool) {
        const events = ports.events
        if (!events) {
          throw new AgentRuntimePreparationError('Agent permission request event host is not configured', 'permission_event_host_missing', 'permission_host')
        }
        const emit: EventPort['emit'] = (sessionId, payload) => events.emit(sessionId, payload)
        prepared.canUseTool = ports.permissions.createCanUseTool({
          sessionId: input.sessionId,
          runId: input.runId,
          signal,
          runLifecycle: input.runLifecycle,
          sendPermissionRequest: request => emit(input.sessionId, { kind: 'profer_event', event: { type: 'permission_request', request } }),
          sendAskUserRequest: request => emit(input.sessionId, { kind: 'profer_event', event: { type: 'ask_user_request', request } }),
          handleAskUser: (sessionId, toolInput, requestSignal, sendToRenderer) => {
            const handler = ports.permissions?.handleAskUserQuestion
            if (!handler) return Promise.resolve({ behavior: 'deny', message: 'AskUser 服务不可用' })
            return handler({ sessionId, toolInput, signal: requestSignal, sendToRenderer })
          },
        })
      }
      if (prepared.tools === undefined && input.toolAssemblyContext) {
        if (!ports.toolAssembly) {
          throw new AgentRuntimePreparationError('Agent tool assembly host is not configured', 'tool_assembly_host_missing', 'tool_assembly')
        }
        const result = await ports.toolAssembly.build(input.toolAssemblyContext)
        signal.throwIfAborted()
        prepared.tools = result.tools
        prepared.collaborationAvailable = result.collaborationAvailable
      }
      signal.throwIfAborted()
      return prepared
    },
  }
}
