import { randomUUID } from 'node:crypto'
import type { PermissionPort, RuntimeCanUseTool, RuntimePermissionResult } from '@profer/agent-runtime'
import { createPlanModeToolPolicy, type PlanModeToolPolicy } from '@profer/agent-runtime/plan-mode-tool-policy'
import type { PermissionRequest } from '@profer/shared'
import { SAFE_TOOLS, canonicalAgentToolName, isSafeBashCommand } from '@profer/shared'

type Pending = {
  sessionId: string
  toolName: string
  request: PermissionRequest
  resolve: (result: RuntimePermissionResult) => boolean
}

/** Core-owned permission requests. No response, disconnect, or abort ever implies allow. */
export class CorePermissionService implements PermissionPort {
  private readonly pending = new Map<string, Pending>()
  private readonly whitelist = new Map<string, Map<string, Set<string>>>()
  constructor(
    private readonly emit: (sessionId: string, payload: unknown) => void,
    private readonly permissionMode: (sessionId: string) => import('@profer/shared').ProferPermissionMode = () => 'auto',
    private readonly planPolicy: (sessionId: string) => PlanModeToolPolicy = () => createPlanModeToolPolicy(undefined),
    private readonly toolDisabled: (sessionId: string, toolName: string) => boolean = () => false,
  ) {}

  getMode(sessionId: string): import('@profer/shared').ProferPermissionMode { return this.permissionMode(sessionId) }

  createCanUseTool(input: Parameters<NonNullable<PermissionPort['createCanUseTool']>>[0]): RuntimeCanUseTool {
    return async (toolName, toolInput, options) => {
      if (options.signal.aborted || input.signal?.aborted) return { behavior: 'deny', message: '操作已中止' }
      const name = canonicalAgentToolName(toolName)
      if (this.toolDisabled(input.sessionId, toolName)) return { behavior: 'deny', message: '当前预设已禁用此工具' }
      const mode = this.permissionMode(input.sessionId)
      if (mode === 'plan') {
        // 保留 MCP namespace 的默认拒绝语义；Pi 内建工具别名归一化到共享策略名。
        const decision = this.planPolicy(input.sessionId)({ toolName: toolName.startsWith('mcp__') ? toolName : name,
          toolInput: { ...toolInput, file_path: toolInput.file_path ?? toolInput.path },
        })
        return decision?.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: toolInput }
          : { behavior: 'deny', message: decision?.message ?? 'Core 尚不支持此计划模式交互工具' }
      }
      if (mode === 'bypassPermissions') return { behavior: 'allow', updatedInput: toolInput }
      const inputKey = JSON.stringify(toolInput)
      if (this.whitelist.get(input.sessionId)?.get(name)?.has(inputKey) || SAFE_TOOLS.includes(name) || name === 'Ls' || name === 'TodoRead'
        || name === 'Bash' && typeof toolInput.command === 'string' && isSafeBashCommand(toolInput.command)) {
        return { behavior: 'allow', updatedInput: toolInput, ...(options.toolUseID ? { toolUseID: options.toolUseID } : {}) }
      }
      const requestId = randomUUID()
      const request: PermissionRequest = {
        requestId, sessionId: input.sessionId, runId: input.runId, toolName,
        toolInput: structuredClone(toolInput), description: options.description ?? `${toolName} requires approval`,
        dangerLevel: name === 'Bash' || name === 'Write' || name === 'Edit' ? 'dangerous' : 'normal',
        ...(options.toolUseID ? { toolUseID: options.toolUseID } : {}),
        ...(options.displayName ? { sdkDisplayName: options.displayName } : {}),
        ...(options.title ? { sdkTitle: options.title } : {}),
      }
      return new Promise<RuntimePermissionResult>(resolve => {
        let settled = false
        const finish = (result: RuntimePermissionResult): boolean => {
          if (settled) return false
          settled = true
          this.pending.delete(requestId)
          options.signal.removeEventListener('abort', onAbort)
          input.signal?.removeEventListener('abort', onAbort)
          try { input.runLifecycle?.resume(requestId) }
          catch (error) { result = { behavior: 'deny', message: `权限恢复记账失败：${String(error)}` } }
          resolve(result)
          return result.behavior === 'allow'
        }
        const onAbort = (): void => { finish({ behavior: 'deny', message: '操作已中止', ...(options.toolUseID ? { toolUseID: options.toolUseID } : {}) }) }
        this.pending.set(requestId, { sessionId: input.sessionId, toolName: name, resolve: finish, request })
        options.signal.addEventListener('abort', onAbort, { once: true })
        input.signal?.addEventListener('abort', onAbort, { once: true })
        try {
          input.runLifecycle?.wait(requestId)
          input.sendPermissionRequest(request)
        } catch (error) {
          finish({ behavior: 'deny', message: `权限请求发送或记账失败：${String(error)}` })
        }
        if (options.signal.aborted || input.signal?.aborted) onAbort()
      })
    }
  }

  respond(sessionId: string, requestId: string, behavior: 'allow' | 'deny', alwaysAllow = false, runId?: string): boolean {
    const pending = this.pending.get(requestId)
    if (!pending || pending.sessionId !== sessionId || pending.request.runId !== runId) return false
    // 权限收紧后，旧审批不能重新放行副作用，也不能写入会话白名单。
    if (this.permissionMode(sessionId) === 'plan') behavior = 'deny'
    const allowed = pending.resolve(behavior === 'allow'
      ? { behavior: 'allow', updatedInput: pending.request.toolInput, ...(pending.request.toolUseID ? { toolUseID: pending.request.toolUseID } : {}), decisionClassification: alwaysAllow ? 'user_permanent' : 'user_temporary' }
      : { behavior: 'deny', message: '用户拒绝了此操作', ...(pending.request.toolUseID ? { toolUseID: pending.request.toolUseID } : {}), decisionClassification: 'user_reject' })
    if (allowed && alwaysAllow) {
      const current = this.whitelist.get(sessionId) ?? new Map<string, Set<string>>()
      const inputs = current.get(pending.toolName) ?? new Set<string>()
      inputs.add(JSON.stringify(pending.request.toolInput))
      current.set(pending.toolName, inputs)
      this.whitelist.set(sessionId, current)
    }
    this.emit(sessionId, { kind: 'profer_event', event: { type: 'permission_resolved', requestId, behavior: allowed ? 'allow' : 'deny' } })
    return true
  }

  listPending(sessionId: string): PermissionRequest[] {
    return [...this.pending.values()].filter(item => item.sessionId === sessionId).map(item => structuredClone(item.request))
  }

  invalidatePending(sessionId: string, runId?: string): void {
    for (const pending of this.pending.values()) {
      if (pending.sessionId !== sessionId || (runId !== undefined && pending.request.runId !== runId)) continue
      pending.resolve({ behavior: 'deny', message: '运行结束或权限模式已变更，请求失效' })
      this.emit(sessionId, { kind: 'profer_event', event: { type: 'permission_resolved', requestId: pending.request.requestId, behavior: 'deny' } })
    }
  }

  clearSession(sessionId: string): void {
    for (const pending of this.pending.values()) {
      if (pending.sessionId === sessionId) pending.resolve({ behavior: 'deny', message: '会话已关闭' })
    }
    this.whitelist.delete(sessionId)
  }
}
