/**
 * Agent Fabric Headless 执行器适配
 *
 * 设计文档 §13：现有 headless runner 是执行实现，通过适配器接入统一 Task Protocol。
 * 本模块把 Gateway 的 TaskExecutor 端口接到现有
 * `agent-headless-runner-registry`（避免与 orchestrator 循环依赖的既有解耦点）。
 *
 * 任务 → 会话映射：每个 Fabric 任务创建一个真实 Agent 会话（可审计、可在 UI 查看），
 * 会话引用作为日志产物挂到任务结果上。
 *
 * 权限仍由目标会话的 EffectiveAgentPresetPolicy 判定；来源与启动依据只作追溯，
 * 不将无人值守、任务正文或外部 metadata 当作扩大权限的依据。
 */

import { isChannelEnabledForRuntime, readMessageProvenance, type AgentMessage, type AgentRuntime } from '@profer/shared'
import {
  ArtifactKind,
  type TaskExecution,
  type TaskExecutor,
  type TaskReporter,
  type TaskResult,
} from '@profer/agent-fabric'
import { runRegisteredHeadlessAgent, stopRegisteredAgent } from '../agent-headless-runner-registry'
import { stopAgent, agentEventBus, findAgentRunForTrigger } from '../agent-service'
import { createAgentSession, getAgentSessionMessages } from '../agent-session-manager'
import { getVisibleChannelById } from '../channel-manager'
import { getSettings } from '../settings-service'
import type { AgentFabricConfig } from './fabric-config'

const SUMMARY_CHAR_LIMIT = 4_000

export interface HeadlessExecutorDeps {
  config: AgentFabricConfig
}

/** 组装任务的执行提示词：目标 + 约束 + 显式上下文（设计文档 §5.1）。 */
function buildTaskPrompt(execution: TaskExecution): string {
  const { request } = execution.task
  const lines: string[] = [
    `你是一个被 Profer Agent Fabric 派工的本地执行节点。任务 ID：${request.taskId}。`,
    ``,
    `目标：${request.objective}`,
  ]
  if (request.constraints.length > 0) {
    lines.push(``, `约束（必须遵守）：`)
    for (const constraint of request.constraints) lines.push(`- ${constraint}`)
  }
  if (request.context?.files && request.context.files.length > 0) {
    lines.push(``, `相关文件：`)
    for (const file of request.context.files) lines.push(`- ${file}`)
  }
  if (request.context?.notes) {
    lines.push(``, `补充说明：${request.context.notes}`)
  }
  lines.push(
    ``,
    `完成后用一段简洁中文总结结果：做了什么、验证方式与结果、遗留问题。`,
    `不要声称执行过你实际没有执行的命令或测试。`,
  )
  return lines.join('\n')
}

/** 从会话消息构建结构化结果：结论与证据分开（§11）。 */
function buildTaskResult(execution: TaskExecution, messages: AgentMessage[] | undefined, sessionId: string): TaskResult {
  const lastAssistant = [...(messages ?? [])].reverse().find((message) => message.role === 'assistant' && message.content.trim())
  const summary = (lastAssistant?.content ?? '').slice(0, SUMMARY_CHAR_LIMIT) || '（无文本总结）'

  const transcriptArtifactId = `session-transcript-${sessionId}`
  // 证据引用会话本身；transcript 内容由 artifact 读取端点受控返回。
  return {
    status: 'completed',
    summary,
    changedFiles: [],
    testResults: [],
    artifacts: [
      {
        artifactId: transcriptArtifactId,
        taskId: execution.task.request.taskId,
        kind: ArtifactKind.LOG,
        mimeType: 'text/markdown',
        createdAt: Date.now(),
        label: `Fabric 任务会话转录（session ${sessionId}）`,
      },
    ],
    evidence: [{ type: 'log', ref: transcriptArtifactId }],
    blockers: [],
    nextActions: [],
  }
}

export function createHeadlessTaskExecutor(deps: HeadlessExecutorDeps): TaskExecutor {
  /** taskId -> sessionId，用于取消时停止对应会话。 */
  const runningSessions = new Map<string, string>()

  return {
    start(execution: TaskExecution): void {
      const reporter: TaskReporter = execution.reporter
      const taskId = execution.task.request.taskId
      // Fabric 当前没有独立 attempt/retry 入口；同一 Task 是同一次业务触发。
      // 重放复用账本，新的显式执行应使用新 Task ID，不能用随机 ID 重放副作用。
      const triggerId = `fabric:${taskId}`
      let sessionId: string | undefined
      let ownsSession = false
      let unsubscribeBus: (() => void) | undefined
      let finished = false
      let backgroundPending = false
      const admittedRuns = new Set<string>()
      const reportRun = (runId: string, actualSessionId?: string): void => {
        if (finished || admittedRuns.has(runId)) return
        reporter.runAdmitted?.({ runId, ...(actualSessionId ? { sessionId: actualSessionId } : {}), triggerId })
        admittedRuns.add(runId)
      }
      const admitFromLedger = (): ReturnType<typeof findAgentRunForTrigger> => {
        const run = findAgentRunForTrigger(triggerId)
        if (!run) return undefined
        if (run.taskId !== taskId || run.triggerId !== triggerId || (sessionId && run.sessionRef !== sessionId)) {
          throw new Error(`Fabric 任务 ${taskId} 的 Run 关联不一致，禁止重放执行`)
        }
        reportRun(run.id, run.sessionRef)
        return run
      }
      const finish = (outcome: { error: string } | { messages?: AgentMessage[] }): void => {
        if (finished) return
        try { admitFromLedger() } catch (error) {
          outcome = { error: error instanceof Error ? error.message : String(error) }
        }
        finished = true
        unsubscribeBus?.()
        if (ownsSession && runningSessions.get(taskId) === sessionId) runningSessions.delete(taskId)
        if ('error' in outcome) reporter.fail(outcome.error)
        else reporter.complete(buildTaskResult(execution, outcome.messages, sessionId!))
      }

      void (async () => {
        try {
          // 先与共享运行账本对账，再创建会话；同业务触发不得重复启动。
          const existing = admitFromLedger()
          if (existing) {
            sessionId = existing.sessionRef
            if (existing.status === 'completed' && sessionId) finish({ messages: getAgentSessionMessages(sessionId) })
            else finish({ error: existing.failureReason ?? (existing.status === 'stopped' ? '执行已停止'
              : existing.status === 'failed' ? '执行失败' : `Run ${existing.id} 尚未结束，需由宿主确认恢复`) })
            return
          }
          if (runningSessions.has(taskId)) {
            finish({ error: `Fabric 任务 ${taskId} 尚未结束，禁止重复启动` })
            return
          }
          const settings = getSettings()
          const channelId = deps.config.defaultChannelId || settings.agentChannelId || ''
          if (!channelId) {
            finish({ error: '未配置模型渠道（settings.agentChannelId 为空），无法执行 Fabric 任务' })
            return
          }
          const workspaceId = execution.task.request.workspaceId || deps.config.defaultWorkspaceId
          // 内核跟随全局默认（主推 Pi）。写死 'claude' 会让 Pi-only 渠道上的 Fabric 任务必然失败，
          // 且失败原因埋在 SDK 层，因此这里先按渠道能力校验再建会话。
          const agentRuntime: AgentRuntime = settings.agentRuntime ?? 'claude'
          const channel = getVisibleChannelById(channelId)
          if (!channel) {
            finish({ error: `Fabric 任务无法执行：渠道不存在（${channelId}）` })
            return
          }
          if (!isChannelEnabledForRuntime(channel, agentRuntime)) {
            finish({ error:
              `Fabric 任务无法执行：渠道「${channel.name}」未启用或未开放 ${agentRuntime} 内核；`
              + `请在该渠道设置中勾选 ${agentRuntime}，或在设置中切换默认 Agent 内核`,
            })
            return
          }
          // 默认模型可能来自另一个渠道；回退到该渠道第一个启用模型，避免带着不存在的模型启动。
          const preferredModelId = deps.config.defaultModelId ?? settings.agentModelId
          const modelId = channel.models.find((model) => model.id === preferredModelId && model.enabled)?.id
            ?? channel.models.find((model) => model.enabled)?.id
          if (!modelId) {
            finish({ error: `Fabric 任务无法执行：渠道「${channel.name}」没有启用的模型` })
            return
          }

          const session = createAgentSession(
            `[Fabric] ${execution.task.request.objective.slice(0, 40)}`,
            channelId,
            workspaceId,
            modelId,
            agentRuntime,
            false,
            execution.task.request.preset,
          )
          sessionId = session.id
          ownsSession = true
          runningSessions.set(taskId, session.id)

          // 进度桥接：会话事件总线 → task.progress（只转发结构化摘要，不内联全文）。
          unsubscribeBus = agentEventBus.on((sessionId, payload) => {
            if (sessionId !== session.id || finished) return
            try {
              if (payload.kind === 'sdk_message') {
                const provenance = readMessageProvenance(payload.message._provenance)
                if (provenance?.taskId === taskId && provenance.triggerId === triggerId) {
                  reportRun(provenance.runId, session.id)
                }
              }
              if (admittedRuns.size === 0) admitFromLedger()
              if (payload.kind === 'sdk_message') {
                reporter.progress({ sessionId: session.id, messageType: payload.message.type })
              } else if (payload.kind === 'profer_event') {
                reporter.progress({ sessionId: session.id, proferEvent: payload.event.type })
              }
            } catch (error) {
              finish({ error: error instanceof Error ? error.message : String(error) })
            }
          })

          // gateway 在进入 executor 前以认证调用者重写来源。仅消费该契约，
          // 不解析 objective/context 中的身份自述；旧任务仍标为 external。
          const origin = execution.task.request.origin ?? {
            actor: { type: 'external' as const, id: execution.task.request.requesterAgentId },
            source: { type: 'task' as const, id: taskId },
          }
          const authorization = execution.task.request.authorization ?? {
            kind: 'external' as const,
            sourceRef: origin.source,
          }
          await runRegisteredHeadlessAgent(
            {
              sessionId: session.id,
              taskId,
              triggerId,
              taskOrigin: origin,
              taskAuthorization: authorization,
              messageAuthor: origin.actor,
              userMessage: buildTaskPrompt(execution),
              channelId,
              modelId,
              workspaceId,
              triggeredBy: 'delegation',
            },
            {
              source: 'bridge',
              onError: (error) => { finish({ error }) },
              onComplete: (messages, opts) => {
                if (finished) return
                try { admitFromLedger() } catch (error) {
                  finish({ error: error instanceof Error ? error.message : String(error) })
                  return
                }
                if (opts?.backgroundTasksPending) { backgroundPending = true; return }
                backgroundPending = false
                if (opts?.stoppedByUser) finish({ error: '执行被用户停止' })
                else if (opts?.resultErrors?.length) finish({ error: opts.resultErrors.join('\n') })
                else if (opts?.endReason && opts.endReason !== 'completed') finish({ error: opts.endReasonLabel || `执行中断：${opts.endReason}` })
                else if (opts?.resultSubtype && opts.resultSubtype !== 'success') finish({ error: `执行未完成：${opts.resultSubtype}` })
                else finish({ messages })
              },
              onTitleUpdated: () => { /* 会话标题由会话管理器维护 */ },
            },
          )
          if (!finished) {
            const run = admitFromLedger()
            if (run?.status === 'failed' || run?.status === 'stopped') {
              finish({ error: run.failureReason ?? (run.status === 'stopped' ? '执行已停止' : '执行失败') })
            } else if (!backgroundPending) {
              finish({ error: '执行器退出但没有报告真实终态' })
            }
          }
        } catch (error) {
          finish({ error: error instanceof Error ? error.message : String(error) })
        }
      })()
    },

    cancel(taskId: string): void {
      const sessionId = runningSessions.get(taskId)
      if (!sessionId) return
      // 优先走 orchestrator 注入的 stopper（委派取消语义）；未初始化时退回 stopAgent。
      try {
        stopRegisteredAgent(sessionId, 'delegation_cancel')
      } catch {
        void stopAgent(sessionId)
      }
    },
  }
}
