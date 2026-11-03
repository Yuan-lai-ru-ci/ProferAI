/**
 * 定时任务（Automation）调度器
 *
 * 核心设计（见 .context/plan/automation-feature.md）：
 * - 用「下次触发时间戳 + 短 tick 轮询」而非长 setInterval，避免系统休眠导致的定时器漂移
 * - 子会话归属按 sessionMode 决定：
 *     · daily（默认）：同一自然日内的触发复用同一个子会话，跨日自动新建（兼顾上下文连续性与成本控制）。
 *       叠加安全阀：同日若上次会话上下文占用率已达 DAILY_CONTEXT_ROLLOVER_THRESHOLD，本次也主动新建，
 *       避免运行刚开始就触发 SDK 自动压缩。
 *     · reuse：始终复用同一个子会话（用户主动选择，长期 token 成本由用户承担）
 * - 强制 bypassPermissions，否则无人值守时写操作会因权限弹窗永久阻塞
 * - 来源会话/目标会话忙时保留持久 queued trigger，下一次 tick 重试，不跳过或改写 occurrence 时间
 * - 连续失败达上限自动暂停
 * - 启动时恢复：queued 保留重试，running 收敛 interrupted；已有共享 Run 先对账，不重放副作用
 */

import type { AgentRun } from '@profer/agent-runtime'
import type { HeadlessAgentRunCallbacks } from './agent-headless-runner-registry'
import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import {
  AUTOMATION_MAX_CONSECUTIVE_FAILURES,
  AUTOMATION_IPC_CHANNELS,
  RECOMMENDATION_IPC_CHANNELS,
  AUTOMATION_DEFAULT_SESSION_MODE,
  type AgentRuntime,
  type AgentSendInput,
  type Automation,
  type AutomationRun,
  normalizeAgentRuntime,
} from '@profer/shared'
import {
  listAutomations,
  getAutomation,
  settleAutomationTrigger,
  linkAutomationTriggerRun,
  updateAutomation,
  setLastSessionId,
  computeNextRunAt,
  enqueueAutomationTrigger,
  getPendingAutomationTrigger,
  getAutomationTrigger,
  listAutomationTriggers,
  transitionAutomationTriggerRecord,
  setNextRunAt,
} from './automation-manager'
import { createAutomationTriggerId, buildAutomationDispatchMetadata, validateBoundAutomationChannel, validateBoundAutomationSession, isSettledAutomationTrigger } from './automation-dispatch'
import { createAgentSession, updateAgentSessionMeta, getAgentSessionMeta } from './agent-session-manager'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getChannelById } from './channel-manager'
import { resolvePresetId, getDefaultPresetId } from './agent-preset-manager'
import { getSessionContextUsageRatio } from './agent-session-usage'
import { runAgentHeadless, runAgentRuntimeHeadless, isAgentSessionActive, peekAgentRunClaimFailureForSession, findAgentRunForTrigger } from './agent-service'
import { notifyAutomationRunFinished } from './automation-notification-service'

/** tick 周期：每 30s 检查一次到期任务（短轮询，抗休眠漂移） */
const TICK_INTERVAL_MS = 30_000

/** 单次任务执行的超时上限：2 小时。超时后强制标记为 error 并释放 runningAutomations 槽位 */
const RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000

/**
 * daily 模式下的上下文占用率切换阈值。
 * 当同日复用的会话上下文占用 ≥ 此值时，本次自动新建会话。
 * 留出与 SDK 自动压缩阈值（约 77.5%）的安全余量，避免本次运行刚开始就被压缩。
 */
const DAILY_CONTEXT_ROLLOVER_THRESHOLD = 0.7

/**
 * 判断两个时间戳是否落在同一个本地自然日。
 * 用 new Date().getFullYear/Month/Date 直接取本地时区年月日，避免引入时区库或字符串解析。
 */
function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a)
  const db = new Date(b)
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  )
}

function formatScheduleLabel(a: Automation): string {
  if (a.scheduleType === 'once') {
    const when = a.scheduledAt
      ? new Date(a.scheduledAt).toLocaleString('zh-CN', {
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        })
      : '指定时间'
    return `仅运行一次（${when}）`
  }
  const times = (a.timeOfDay?.length ? a.timeOfDay : ['09:00']).join('、')
  if (a.scheduleType === 'daily') return `每天 ${times}`
  if (a.scheduleType === 'weekly') {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    const days = (a.dayOfWeek?.length ? a.dayOfWeek : [1])
      .map((day) => names[day] ?? `星期${day}`)
      .join('、')
    return `每${days} ${times}`
  }
  if (a.scheduleType === 'monthly') {
    const days = (a.dayOfMonth?.length ? a.dayOfMonth : [1]).join('、')
    return `每月 ${days} 号 ${times}`
  }
  const min = a.intervalMinutes
  if (min < 60) return `每 ${min} 分钟`
  if (min < 1440) return `每 ${min / 60} 小时`
  return `每 ${min / 1440} 天`
}

let tickTimer: NodeJS.Timeout | undefined
/** 正在执行中的 automation id 集合，防止同一任务重入 */
const runningAutomations = new Set<string>()

/** 向所有渲染窗口广播任务列表变更，触发前端刷新 */
export function broadcastChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(AUTOMATION_IPC_CHANNELS.CHANGED)
      win.webContents.send(RECOMMENDATION_IPC_CHANNELS.CHANGED)
    }
  }
}

/**
 * 执行一次定时任务：新建子会话 + headless 运行
 *
 * @param automation 任务定义
 * @param manual 是否手动「立即运行」（手动运行也走同一路径，但不影响调度计时由 appendRun 统一推进）
 */
export async function runAutomation(automation: Automation, manual = false): Promise<void> {
  // 工作区已不可解析（project 被移除只删索引）时绝不执行：
  // 会话与 headless 运行会拿不到 workspaceSlug，cwd 回落用户主目录，
  // 等于把 ~ 当项目根跑无人值守命令。这里停用任务并结束。
  if (automation.workspaceId && !getAgentWorkspace(automation.workspaceId)) {
    console.warn(
      `[定时任务] ${automation.name} 绑定的工作区已不存在（workspaceId=${automation.workspaceId}），已停用，本次不执行`,
    )
    updateAutomation({ id: automation.id, active: false })
    broadcastChanged()
    if (manual) throw new Error('该定时任务绑定的项目已被移除，请重新选择工作区后再运行')
    return
  }
  const scheduledAt = manual ? Date.now() : automation.nextRunAt
  const triggerId = manual
    ? `${automation.id}:manual:${scheduledAt}:${randomUUID()}`
    : createAutomationTriggerId(automation.id, scheduledAt)
  const existingTrigger = manual ? undefined : getPendingAutomationTrigger(automation.id)
  let trigger = existingTrigger ?? enqueueAutomationTrigger({
    triggerId,
    occurrenceId: triggerId,
    automationId: automation.id,
    kind: manual ? 'manual' : 'scheduled',
    scheduledAt,
    status: 'queued',
    ...(automation.boundSessionId ? { boundSessionId: automation.boundSessionId } : {}),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  if (!existingTrigger) broadcastChanged()
  if (runningAutomations.has(automation.id)) {
    console.log(`[定时任务] ${automation.name} 目标仍在运行，保留 queued trigger: ${trigger.triggerId}`)
    return
  }

  if (isSettledAutomationTrigger(trigger) || trigger.status === 'cancelled') return
  const runAt = Date.now()
  let executionStarted = false

  const recordResult = (status: 'success' | 'error', error?: string, sharedRun?: AgentRun, sessionId?: string): void => {
    const startedAt = sharedRun?.startedAt ?? runAt
    const run: AutomationRun = {
      runAt: startedAt,
      sessionId: sharedRun?.sessionRef ?? sessionId ?? trigger.targetSessionId ?? '',
      status,
      durationMs: Math.max(0, (sharedRun?.finishedAt ?? Date.now()) - startedAt),
      error,
      triggerId: trigger.triggerId,
      runId: sharedRun?.id ?? trigger.runId,
    }
    const latest = settleAutomationTrigger(trigger.triggerId, run)
    if (!latest) return
    broadcastChanged()
    void notifyAutomationRunFinished({ automation, run }).catch((notifyError) => {
      console.error(`[定时任务] 发送完成通知失败: ${automation.name}`, notifyError)
    })
    if (latest.active && (latest.consecutiveFailures ?? 0) >= AUTOMATION_MAX_CONSECUTIVE_FAILURES) {
      updateAutomation({ id: automation.id, active: false })
      broadcastChanged()
    }
  }
  const linkRun = (run: AgentRun): void => {
    const changed = trigger.runId !== run.id || (run.sessionRef !== undefined && trigger.targetSessionId !== run.sessionRef)
    trigger = linkAutomationTriggerRun(trigger.triggerId, run.id, run.sessionRef) ?? trigger
    if (changed) broadcastChanged()
  }
  const blockTrigger = (reason: string): void => {
    trigger = transitionAutomationTriggerRecord(trigger.triggerId, 'blocked', { error: reason }) ?? trigger
    broadcastChanged()
  }
  const reconcileRun = (run: AgentRun): void => {
    linkRun(run)
    if (run.status === 'completed' && run.finishedAt !== undefined) {
      recordResult('success', undefined, run)
      return
    }
    if (run.status === 'failed' || run.status === 'stopped') {
      recordResult('error', run.failureReason ?? (run.status === 'stopped' ? '共享 Run 已停止' : '共享 Run 执行失败'), run)
      return
    }
    blockTrigger(`共享 Run ${run.id} 状态 ${run.status}，执行终态无法确认；等待对账，不自动重放`)
  }

  try {
    const previousRun = findAgentRunForTrigger(trigger.triggerId)
    if (previousRun) {
      reconcileRun(previousRun)
      return
    }
    if (trigger.runId || trigger.targetSessionId) {
      blockTrigger('无法确认此前执行状态：共享 Run 不存在；不自动重放')
      return
    }
  } catch (error) {
    blockTrigger(`共享 Run 对账失败，不自动重放：${error instanceof Error ? error.message : String(error)}`)
    return
  }

  try {
    // 根据 sessionMode 决定新建或复用子会话
    //  - reuse：lastSessionId 存在且会话还活着就复用，否则新建
    //  - daily：再叠加一层「同一自然日」+「上下文占用率 < 阈值」双重判断
    //    （基于 automation.lastRunAt 排除 skipped 运行；占用率读不到时按"未知"保守复用）
    const sessionMode = automation.sessionMode ?? AUTOMATION_DEFAULT_SESSION_MODE
    const agentRuntime: AgentRuntime = normalizeAgentRuntime(automation.agentRuntime)

    let reuseSessionId: string | undefined
    const lastSessionMeta = automation.lastSessionId ? getAgentSessionMeta(automation.lastSessionId) : undefined
    // 已被用户手动接管（毕业）的会话不再复用，强制新建，避免把定时任务消息注入用户的私人会话
    if (lastSessionMeta?.automationGraduated) {
      console.log(`[定时任务] ${automation.name} 上次会话已被用户接管，本次自动开新会话`)
    }
    // 任务改内核时另开会话；旧会话及其 transcript/检查点保留。
    if (automation.lastSessionId && lastSessionMeta && !lastSessionMeta.automationGraduated
      && normalizeAgentRuntime(lastSessionMeta.agentRuntime) === agentRuntime) {
      if (sessionMode === 'reuse') {
        reuseSessionId = automation.lastSessionId
      } else if (
        sessionMode === 'daily' &&
        automation.lastRunAt &&
        isSameLocalDay(automation.lastRunAt, runAt)
      ) {
        const usageRatio = getSessionContextUsageRatio(automation.lastSessionId)
        if (usageRatio === undefined || usageRatio < DAILY_CONTEXT_ROLLOVER_THRESHOLD) {
          reuseSessionId = automation.lastSessionId
        } else {
          console.log(
            `[定时任务] ${automation.name} 上下文占用 ${(usageRatio * 100).toFixed(1)}% 已达阈值 ${DAILY_CONTEXT_ROLLOVER_THRESHOLD * 100}%，本次自动开新会话`,
          )
        }
      }
    }

    let targetSessionId: string
    if (automation.boundSessionId) {
      const bound = getAgentSessionMeta(automation.boundSessionId)
      const workspaceSlug = automation.workspaceId ? getAgentWorkspace(automation.workspaceId)?.slug : undefined
      const expectedPresetId = automation.presetId?.trim()
        ? resolvePresetId(workspaceSlug, automation.presetId.trim())
        : getDefaultPresetId(workspaceSlug)
      const validation = validateBoundAutomationSession(automation, bound, expectedPresetId)
      if (!validation.valid) throw new Error(`定时任务目标会话不可用：${validation.reason}`)
      if (!bound) throw new Error('定时任务目标会话不可用：绑定会话不存在或不可访问')
      const boundAvailability = validateBoundAutomationChannel(automation, bound, getChannelById(automation.channelId))
      if (!boundAvailability.valid) throw new Error(`定时任务目标会话不可用：${boundAvailability.reason}`)
      targetSessionId = automation.boundSessionId
    } else if (reuseSessionId) {
      targetSessionId = reuseSessionId
    } else {
      // 预设解析：任务指定 → 直接绑定；未指定 → 跟随任务工作区的默认预设（无则 standard）。
      // createAgentSession 内部会按工作区再规范化一次，未知 ID 回退 standard。
      const workspaceSlug = automation.workspaceId ? getAgentWorkspace(automation.workspaceId)?.slug : undefined
      const presetId = automation.presetId?.trim() || getDefaultPresetId(workspaceSlug)
      const created = createAgentSession(automation.name, automation.channelId, automation.workspaceId, automation.modelId, agentRuntime, false, presetId || undefined)
      updateAgentSessionMeta(created.id, { sourceAutomationId: automation.id, agentRuntime })
      targetSessionId = created.id
      setLastSessionId(automation.id, created.id)
    }

    const targetSessionMeta = getAgentSessionMeta(targetSessionId)
    if (!targetSessionMeta) throw new Error(`定时任务目标会话不存在：${targetSessionId}`)
    if (trigger.status === 'blocked') {
      trigger = transitionAutomationTriggerRecord(trigger.triggerId, 'queued', { error: undefined }) ?? { ...trigger, status: 'queued', error: undefined }
      broadcastChanged()
    }
    if (isAgentSessionActive(targetSessionId)) {
      console.log(`[定时任务] ${automation.name} 目标会话忙，保留 queued trigger: ${trigger.triggerId}`)
      return
    }
    // 复用会话时同步任务预设：用户改了任务 presetId，下一轮消息就按新预设生效
    //（与「会话内切换预设，下一轮消息完整生效」语义一致）。未指定 presetId 时不覆盖会话现状。
    if (reuseSessionId && automation.presetId?.trim()) {
      const workspaceSlug = automation.workspaceId ? getAgentWorkspace(automation.workspaceId)?.slug : undefined
      const resolvedPresetId = resolvePresetId(workspaceSlug, automation.presetId.trim())
      if (targetSessionMeta && targetSessionMeta.presetId !== resolvedPresetId) {
        updateAgentSessionMeta(targetSessionId, { presetId: resolvedPresetId })
        console.log(`[定时任务] ${automation.name} 已同步预设到复用会话: ${resolvedPresetId}`)
      }
    }

    await new Promise<void>((resolveRun, rejectRun) => {
      let settled = false
      let observedError: string | undefined
      const release = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timeoutTimer)
        resolveRun()
      }
      const observeSharedRun = (): AgentRun | undefined => {
        const run = findAgentRunForTrigger(trigger.triggerId)
        if (run) linkRun(run)
        return run
      }
      const complete = (fallbackError?: string, runnerFinished = false, rejected = false): void => {
        if (settled) return
        try {
          const sharedRun = observeSharedRun()
          if (rejected) {
            recordResult('error', fallbackError ?? observedError ?? 'Agent 执行失败', sharedRun, targetSessionId)
          } else if (sharedRun?.status === 'completed' && sharedRun.finishedAt !== undefined) {
            recordResult('success', undefined, sharedRun, targetSessionId)
          } else if (sharedRun?.status === 'failed' || sharedRun?.status === 'stopped') {
            recordResult('error', sharedRun.failureReason ?? (sharedRun.status === 'stopped' ? '共享 Run 已停止' : fallbackError ?? observedError ?? '共享 Run 执行失败'), sharedRun, targetSessionId)
          } else if (!sharedRun && fallbackError) {
            recordResult('error', fallbackError ?? observedError ?? 'Agent 执行失败', sharedRun, targetSessionId)
          } else if (runnerFinished || !sharedRun) {
            blockTrigger(sharedRun
              ? `共享 Run ${sharedRun.id} 状态 ${sharedRun.status}，执行终态无法确认；不自动重放`
              : '无法确认真实 Run 终态：共享账本记录不存在；不自动重放')
          } else {
            // completion 可能早于账本写回；只等待同一 headless promise，不新派发。
            return
          }
          release()
        } catch (error) {
          try {
            blockTrigger(`共享 Run 终态对账失败，不自动重放：${error instanceof Error ? error.message : String(error)}`)
            release()
          } catch (persistError) {
            clearTimeout(timeoutTimer)
            settled = true
            rejectRun(persistError)
          }
        }
      }

      // 超时仍先停止真实 Agent；异常收束不伪造共享 ledger 成功。
      const timeoutTimer = setTimeout(async () => {
        try {
          await import('./agent-service').then(m => m.stopAgent(targetSessionId))
        } catch (e) {
          console.warn(`[定时任务] ${automation.name} 停止 Agent 异常:`, e)
        }
        complete(`执行超时（超过 ${RUN_TIMEOUT_MS / 3600_000} 小时）`, true, true)
      }, RUN_TIMEOUT_MS)

      const headlessInput: AgentSendInput = {
        sessionId: targetSessionId,
        userMessage: automation.prompt + '\n<!--PROFER_SCHEDULED_RUN-->',
        automationContext: `这是 Profer 定时任务「${automation.name}」的自动执行（ID: ${automation.id}，${formatScheduleLabel(automation)}）。这本身就是定时任务，不要建议用户再创建定时任务。直接执行任务即可。如发现本任务连续失败、输出价值低、频率不合适或提示词不完整，可以使用 automation 工具读取并更新当前任务。`,
        channelId: automation.channelId,
        modelId: automation.modelId,
        agentRuntime,
        workspaceId: automation.workspaceId,
        permissionModeOverride: automation.permissionMode ?? 'bypassPermissions',
        triggeredBy: 'automation',
        startedAt: runAt,
        ...buildAutomationDispatchMetadata({ automation, triggerId: trigger.triggerId }),
      }
      const callbacks: HeadlessAgentRunCallbacks = {
        source: 'automation',
        onError: (error) => { observedError = error },
        onComplete: (_messages, opts) => {
          if (settled) return
          if (opts?.backgroundTasksPending) {
            try { observeSharedRun() } catch { /* 只关联 runId；轻量完成不承担终态或失败收束。 */ }
            return
          }
          const completionError = opts?.resultErrors?.length ? opts.resultErrors.join('\n')
            : opts?.stoppedByUser ? 'Agent 已停止'
              : opts?.resultSubtype && opts.resultSubtype !== 'success' ? observedError ?? `Agent 执行失败：${opts.resultSubtype}`
                : opts?.endReason && opts.endReason !== 'completed' ? observedError ?? opts.endReasonLabel ?? `Agent 执行结束：${opts.endReason}`
                  : undefined
          complete(completionError ?? observedError)
        },
        onTitleUpdated: () => { /* 自动任务标题不影响运行终态 */ },
      }
      // 使用当前功能开关路由 Runtime；ownership 预检与路由开关无关。
      const useRuntimeAutomation = process.env.PROFER_RUNTIME_AUTOMATION === '1'
      // ownership 预检对 legacy orchestrator 与 Runtime coordinator 共用；两条路径都应把 busy 保留为 queued。
      // 预检与 runAgentHeadless/runAgentRuntimeHeadless 之间没有 await，最终 claim 仍负责互斥。
      const automationBlocked = peekAgentRunClaimFailureForSession(targetSessionId, agentRuntime)
      if (automationBlocked) {
        clearTimeout(timeoutTimer)
        resolveRun()
        return
      }
      runningAutomations.add(automation.id)
      trigger = transitionAutomationTriggerRecord(trigger.triggerId, 'running', { targetSessionId }) ?? trigger
      broadcastChanged()
      executionStarted = true
      try {
        const runtimeRun = useRuntimeAutomation
          ? runAgentRuntimeHeadless(headlessInput, callbacks)
          : runAgentHeadless(headlessInput, callbacks)
        try { observeSharedRun() } catch { /* 等真实终态或 Promise settle 再执行完整对账。 */ }
        void runtimeRun.then(
          () => complete(undefined, true),
          (error) => complete(error instanceof Error ? error.message : '未知错误', true, true),
        )
      } catch (error) {
        complete(error instanceof Error ? error.message : '未知错误', true, true)
      }
    })
  } catch (err) {
    const triggerError = err instanceof Error ? err.message : '未知错误'
    if (!executionStarted && automation.boundSessionId) {
      blockTrigger(triggerError)
      return
    }
    const currentTrigger = getAutomationTrigger(trigger.triggerId)
    if (currentTrigger && !isSettledAutomationTrigger(currentTrigger) && currentTrigger.status !== 'cancelled') {
      recordResult('error', triggerError)
    }
  } finally {
    runningAutomations.delete(automation.id)
  }
}

/** 立即运行一次（手动触发，不影响调度计时之外的逻辑） */
export async function runAutomationNow(id: string): Promise<void> {
  const automation = getAutomation(id)
  if (!automation) throw new Error(`定时任务不存在: ${id}`)
  // 草稿态（缺 channelId / workspaceId）拒绝运行，兜底前端 disabled 防止 IPC 绕过
  if (!automation.channelId || !automation.workspaceId) {
    throw new Error('请先为该任务配置模型与工作区')
  }
  await runAutomation(automation, true)
}

/** 一个 tick：扫描所有 active 且到期的任务并触发 */
function tick(): void {
  const now = Date.now()
  for (const automation of listAutomations()) {
    if (!automation.active) continue
    // 完整度兜底：老用户可能存在「active=true 但缺工作区 / 渠道」的历史数据，跳过避免运行时崩溃
    if (!automation.channelId || !automation.workspaceId) continue
    const queued = listAutomationTriggers().some((trigger) =>
      trigger.automationId === automation.id && (trigger.status === 'queued' || trigger.status === 'blocked'),
    )
    if (now < automation.nextRunAt && !queued) continue
    if (runningAutomations.has(automation.id)) continue
    // 不 await，让多个任务可以并行触发；各自有 runningAutomations 重入保护。
    // 目标会话 busy 时由 runAutomation 留下持久 queued trigger。
    void runAutomation(automation)
  }
}

/**
 * 启动调度器
 *
 * 恢复策略：把已过期的 nextRunAt 顺延到「现在 + 一个完整间隔」，
 * 避免应用重启后一堆历史任务在同一 tick 内雪崩触发。
 */
export function startScheduler(): void {
  if (tickTimer) return
  const now = Date.now()
  for (const automation of listAutomations()) {
    if (automation.active && automation.nextRunAt <= now) {
      const triggerId = createAutomationTriggerId(automation.id, automation.nextRunAt)
      const previous = getAutomationTrigger(triggerId)
      if (previous && isSettledAutomationTrigger(previous)) {
        if (automation.scheduleType === 'once') {
          updateAutomation({ id: automation.id, active: false })
        } else {
          setNextRunAt(automation.id, computeNextRunAt(automation, now))
        }
        continue
      }
      enqueueAutomationTrigger({
        triggerId,
        occurrenceId: triggerId,
        automationId: automation.id,
        scheduledAt: automation.nextRunAt,
        status: 'queued',
        ...(automation.boundSessionId ? { boundSessionId: automation.boundSessionId } : {}),
        createdAt: now,
        updatedAt: now,
      })
    }
  }
  tickTimer = setInterval(tick, TICK_INTERVAL_MS)
  // LIST 的运行态投影也包含启动迁移得到的 interrupted 记录。
  broadcastChanged()
  console.log(`[定时任务] 调度器已启动，tick 周期 ${TICK_INTERVAL_MS / 1000}s`)
}

/** 停止调度器（before-quit 调用） */
export function stopScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = undefined
    console.log('[定时任务] 调度器已停止')
  }
}
