/**
 * Agent AskUserQuestion 交互式问答服务
 *
 * 核心职责：
 * - 拦截 AskUserQuestion 工具调用
 * - 解析问题列表，发送到渲染进程展示交互 UI
 * - 等待用户回答，通过 updatedInput 注入 answers 字段
 * - 管理 pending 请求生命周期
 *
 * 复用权限系统的 Promise + Map 异步等待模式。
 */

import { randomUUID } from 'node:crypto'
import type {
  AskUserRequest,
  AskUserQuestion,
  AskUserQuestionOption,
} from '@profer/shared'
/** canUseTool 返回的权限结果 */
type PermissionResult = {
  behavior: 'allow'
  updatedInput: Record<string, unknown>
} | {
  behavior: 'deny'
  message: string
}

/** 待处理的 AskUser 请求 */
interface PendingAskUser {
  resolve: (result: PermissionResult) => void
  request: AskUserRequest
  /** 原始输入仅留在主进程，用于恢复 SDK 工具调用，不随 renderer request 泄露。 */
  toolInput: Record<string, unknown>
}

/**
 * Agent AskUserQuestion 交互式问答服务
 *
 * 单例模式，管理所有会话的 AskUser 请求。
 */
export class AgentAskUserService {
  /** 待处理的 AskUser 请求 Map（requestId → PendingAskUser） */
  private pendingRequests = new Map<string, PendingAskUser>()
  /**
   * 处理 AskUserQuestion 工具调用
   *
   * 解析问题列表，发送到渲染进程，阻塞等待用户回答，
   * 回答后通过 updatedInput 注入 answers 字段。
   */
  handleAskUserQuestion(
    sessionId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    sendToRenderer: (request: AskUserRequest) => void,
    scope?: { runId?: string; lifecycle?: { wait(id: string): void; resume(id: string): void } },
  ): Promise<PermissionResult> {
    if (signal.aborted) return Promise.resolve({ behavior: 'deny', message: '操作已中止' })
    const questions = this.parseQuestions(input)

    const requestId = randomUUID()
    const rendererToolInput = { ...input }
    const request: AskUserRequest = {
      requestId,
      runId: scope?.runId,
      sessionId,
      questions,
      toolInput: rendererToolInput,
    }

    return new Promise<PermissionResult>((resolve) => {
      const finish = (result: PermissionResult) => {
        if (!this.pendingRequests.delete(requestId)) return
        signal.removeEventListener('abort', abort)
        try { scope?.lifecycle?.resume(requestId) }
        catch (error) { result = { behavior: 'deny', message: `问答恢复记账失败：${String(error)}` } }
        resolve(result)
      }
      const abort = () => finish({ behavior: 'deny', message: '操作已中止' })
      this.pendingRequests.set(requestId, { resolve: finish, request, toolInput: structuredClone(input) })
      signal.addEventListener('abort', abort, { once: true })
      try {
        scope?.lifecycle?.wait(requestId)
        // 先登记再通知，避免同步回答时找不到 pending request。
        sendToRenderer(request)
      } catch (error) {
        finish({ behavior: 'deny', message: `问答请求发送或记账失败：${String(error)}` })
      }
      if (signal.aborted) abort()
    })
  }

  /**
   * 响应 AskUser 请求（由 IPC handler 调用）
   *
   * @returns 对应的 sessionId，用于向渲染进程发送 resolved 事件；未找到返回 null
   */
  async respondToAskUser(requestId: string, answers: Record<string, string>, scope?: { sessionId: string; runId?: string }): Promise<string | null> {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return null
    if (scope && (pending.request.sessionId !== scope.sessionId || pending.request.runId !== scope.runId)) return null
    if (pending.request.runId && !scope) return null
    if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.values(answers).some(value => typeof value !== 'string')) return null

    const sessionId = pending.request.sessionId

    // 构建 updatedInput：保留原始输入 + 注入 answers；内部 metadata 不展示给 renderer。
    const updatedInput: Record<string, unknown> = {
      ...pending.toolInput,
      answers,
    }

    pending.resolve({
      behavior: 'allow' as const,
      updatedInput,
    })
    return sessionId
  }

  /**
   * 获取当前所有待处理的 AskUser 请求（用于渲染进程重载后恢复状态）
   */
  getPendingRequests(): AskUserRequest[] {
    return [...this.pendingRequests.values()].map((p) => structuredClone(p.request))
  }

  /**
   * 清除指定会话的所有待处理 AskUser 请求
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
   * 从工具输入中解析问题列表
   *
   * SDK AskUserQuestion 工具输入格式：
   * { questions: [{ question, header, options: [{ label, description, preview }], multiSelect }] }
   */
  private parseQuestions(input: Record<string, unknown>): AskUserQuestion[] {
    const rawQuestions = input.questions
    if (!Array.isArray(rawQuestions)) return []

    return rawQuestions.filter((q): q is Record<string, unknown> => !!q && typeof q === 'object' && !Array.isArray(q)).map((raw): AskUserQuestion => {
      const options = Array.isArray(raw.options)
        ? (raw.options as unknown[]).filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o)).map((o): AskUserQuestionOption => ({
            label: typeof o.label === 'string' ? o.label : '',
            description: typeof o.description === 'string' ? o.description : undefined,
            preview: typeof o.preview === 'string' ? o.preview.slice(0, 10_000) : undefined,
          }))
        : []

      return {
        question: typeof raw.question === 'string' ? raw.question : '',
        header: typeof raw.header === 'string' ? raw.header : undefined,
        options,
        multiSelect: raw.multiSelect === true,
      }
    })
  }
}
