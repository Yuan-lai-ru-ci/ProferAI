/**
 * Agent ExitPlanMode 计划审批服务
 *
 * 核心职责：
 * - 拦截 ExitPlanMode 工具调用
 * - 解析 allowedPrompts，发送到渲染进程展示审批 UI
 * - 等待用户选择（批准/拒绝/反馈），返回对应 PermissionResult
 * - 根据用户选择切换权限模式
 *
 * 复用 AskUserService 的 Promise + Map 异步等待模式。
 */

import { randomUUID } from 'node:crypto'
import type {
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  ExitPlanAllowedPrompt,
  ProferPermissionMode,
} from '@profer/shared'

/** ExitPlanMode 审批结果（扩展 SDK PermissionResult，附加 targetMode） */
export type ExitPlanPermissionResult = {
  behavior: 'allow'
  updatedInput: Record<string, unknown>
  /** 用户选择的目标权限模式 */
  targetMode?: ProferPermissionMode
} | {
  behavior: 'deny'
  message: string
}

/** 待处理的 ExitPlanMode 请求 */
interface PendingExitPlan {
  resolve: (result: ExitPlanPermissionResult) => boolean
  request: ExitPlanModeRequest
  toolInput: Record<string, unknown>
}

/** ExitPlanMode 审批结果回调（通知编排层切换权限模式） */
export interface ExitPlanModeCallbacks {
  /** 切换权限模式 */
  onPermissionModeChange: (mode: ProferPermissionMode) => void
}

/**
 * Agent ExitPlanMode 计划审批服务
 *
 * 单例模式，管理所有会话的 ExitPlanMode 请求。
 */
export class AgentExitPlanService {
  /** 待处理的请求 Map（requestId → PendingExitPlan） */
  private pendingRequests = new Map<string, PendingExitPlan>()

  /**
   * 处理 ExitPlanMode 工具调用
   *
   * 解析 allowedPrompts，发送到渲染进程，阻塞等待用户选择。
   */
  handleExitPlanMode(
    sessionId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    sendToRenderer: (request: ExitPlanModeRequest) => void,
    scope?: { runId?: string; lifecycle?: { wait(id: string): void; resume(id: string): void } },
  ): Promise<ExitPlanPermissionResult> {
    if (signal.aborted) return Promise.resolve({ behavior: 'deny', message: '操作已中止' })
    const allowedPrompts = this.parseAllowedPrompts(input)

    const request: ExitPlanModeRequest = {
      requestId: randomUUID(),
      runId: scope?.runId,
      sessionId,
      toolInput: input,
      allowedPrompts,
    }

    return new Promise<ExitPlanPermissionResult>((resolve) => {
      const finish = (result: ExitPlanPermissionResult): boolean => {
        if (!this.pendingRequests.delete(request.requestId)) return false
        signal.removeEventListener('abort', abort)
        try { scope?.lifecycle?.resume(request.requestId) }
        catch (error) { result = { behavior: 'deny', message: `计划审批恢复记账失败：${String(error)}` } }
        resolve(result)
        return result.behavior === 'allow'
      }
      const abort = () => finish({ behavior: 'deny', message: '操作已中止' })
      this.pendingRequests.set(request.requestId, { resolve: finish, request, toolInput: structuredClone(input) })
      signal.addEventListener('abort', abort, { once: true })
      try {
        scope?.lifecycle?.wait(request.requestId)
        sendToRenderer(request)
      } catch (error) { finish({ behavior: 'deny', message: `计划审批发送或记账失败：${String(error)}` }) }
      if (signal.aborted) abort()
    })
  }

  /**
   * 响应 ExitPlanMode 请求（由 IPC handler 调用）
   *
   * @returns { sessionId, targetMode } 用于通知编排层；未找到返回 null
   */
  respondToExitPlanMode(response: ExitPlanModeResponse): { sessionId: string; targetMode: ProferPermissionMode | null } | null {
    const pending = this.pendingRequests.get(response.requestId)
    if (!pending) return null
    if (response.sessionId !== undefined && response.sessionId !== pending.request.sessionId) return null
    if (pending.request.runId !== response.runId || pending.request.runId && !response.sessionId) return null

    const sessionId = pending.request.sessionId

    switch (response.action) {
      case 'approve_auto': {
        // 批准 + 切换到完全自动模式
        const allowed = pending.resolve({
          behavior: 'allow' as const,
          updatedInput: pending.toolInput,
          targetMode: 'bypassPermissions',
        })
        return { sessionId, targetMode: allowed ? 'bypassPermissions' : null }
      }
      case 'approve_edit': {
        // 批准 + 切换到自动审批模式
        const allowed = pending.resolve({
          behavior: 'allow' as const,
          updatedInput: pending.toolInput,
          targetMode: 'auto',
        })
        return { sessionId, targetMode: allowed ? 'auto' : null }
      }
      case 'deny': {
        // 拒绝计划
        pending.resolve({
          behavior: 'deny' as const,
          message: '用户拒绝了计划',
        })
        return { sessionId, targetMode: null }
      }
      case 'feedback': {
        // 用户提供反馈，拒绝并附带反馈内容
        pending.resolve({
          behavior: 'deny' as const,
          message: response.feedback ?? '用户要求修改计划',
        })
        return { sessionId, targetMode: null }
      }
      default: {
        pending.resolve({
          behavior: 'deny' as const,
          message: '未知操作',
        })
        return { sessionId, targetMode: null }
      }
    }
  }

  /**
   * 获取当前所有待处理的 ExitPlanMode 请求（用于渲染进程重载后恢复状态）
   */
  getPendingRequests(): ExitPlanModeRequest[] {
    return [...this.pendingRequests.values()].map((p) => structuredClone(p.request))
  }

  /**
   * 清除指定会话的所有待处理请求
   */
  clearSessionPending(sessionId: string, runId?: string): void {
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.request.sessionId === sessionId && (runId === undefined || pending.request.runId === runId)) {
        pending.resolve({ behavior: 'deny', message: '会话已结束' })
        this.pendingRequests.delete(requestId)
      }
    }
  }

  /**
   * 从工具输入中解析 allowedPrompts
   */
  private parseAllowedPrompts(input: Record<string, unknown>): ExitPlanAllowedPrompt[] {
    const raw = input.allowedPrompts
    if (!Array.isArray(raw)) return []

    return raw
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item): ExitPlanAllowedPrompt => ({
        tool: typeof item.tool === 'string' ? item.tool as 'Bash' : 'Bash',
        prompt: typeof item.prompt === 'string' ? item.prompt : '',
      }))
      .filter((item) => item.prompt.length > 0)
  }
}
