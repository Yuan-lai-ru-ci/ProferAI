/**
 * 委派子会话的运行状态显示。
 *
 * 子会话的流式状态由主进程 headless run 推送，但「是否在运行」不能只靠这一路：
 * 子会话页可能在运行中途才被打开、事件可能缺失，而持久化 meta 的 delegationStatus
 * 仍是可靠事实。因此这里把两路信息收敛成同一份显示状态：
 * - 实时流状态优先（可给出准确起点，驱动计时）；
 * - 持久化 status 兜底（只能说明状态，不臆造起点，避免用会话年龄冒充本轮耗时）；
 * - 长时间无任何活动（updatedAt 不前进）时不再伪装成运行中。
 *
 * 纯函数，便于单测；不读取 atom、不调用宿主。
 */

/** 持久化委派状态（与主进程 AgentSessionMeta.delegationStatus 同形）。 */
export type PersistedDelegationStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/** 持久化 running 超过这个时长且没有任何会话活动时，视为状态待确认。 */
export const DELEGATION_RUNNING_STALE_MS = 10 * 60_000

export interface DelegationRuntimeDisplayInput {
  parentSessionId?: string | null
  /** 独立工作关系（placement=independent）没有父会话，用来源会话表达血缘。 */
  sourceSessionId?: string | null
  sourceDelegationId?: string | null
  delegationStatus?: string | null
  /** 渲染层实时流状态是否在运行。 */
  liveRunning: boolean
  /** 实时流状态记录的运行起点（毫秒）。 */
  liveStartedAt?: number
  /**
   * 无实时状态时的起点回退：子会话最近一条人类输入（委派 prompt / 续跑指令）的产生时间。
   * 不从 createdAt 推算，避免续跑会话把整个会话年龄当成本轮耗时。
   */
  fallbackStartedAt?: number
  /** 子会话最后一次活动（消息追加会推进 updatedAt）。 */
  sessionUpdatedAt: number
  now?: number
}

export type DelegationRuntimePhase =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unknown'

export interface DelegationRuntimeDisplay {
  visible: boolean
  phase: DelegationRuntimePhase
  /** 仅运行中且起点可确认时给出；其他状态不显示计时。 */
  startedAt?: number
  /** 状态是否来自实时流；false 表示由持久化 meta 兜底。 */
  live: boolean
  label: string
}

const HIDDEN: DelegationRuntimeDisplay = { visible: false, phase: 'unknown', live: false, label: '' }

const TERMINAL_LABELS: Partial<Record<PersistedDelegationStatus, string>> = {
  completed: '子代理已完成',
  failed: '子代理执行失败',
  cancelled: '子代理已取消',
  interrupted: '子代理已中断',
}

/**
 * 判断会话是否为委派子会话（探索分支走自己的血缘字段，不算委派）。
 *
 * 血缘不能只看 `parentSessionId`：`placement=independent` 的委派只写
 * `sourceSessionId` + `sourceDelegationId`（见 `startDelegation` 里
 * `parentSessionId: relation === 'subtask' ? ctx.sessionId : undefined`）。
 * 只看 parentSessionId 会让这类子会话永远拿不到运行态显示，表现成
 * 「子会话没有 runtime」。
 */
export function isDelegatedChildSessionLike(input: {
  parentSessionId?: string | null
  sourceSessionId?: string | null
  sourceDelegationId?: string | null
}): boolean {
  return Boolean(input.sourceDelegationId && (input.parentSessionId || input.sourceSessionId))
}

export function resolveDelegationRuntimeDisplay(
  input: DelegationRuntimeDisplayInput,
): DelegationRuntimeDisplay {
  if (!isDelegatedChildSessionLike(input)) return HIDDEN


  if (input.liveRunning) {
    return {
      visible: true,
      phase: 'running',
      startedAt: input.liveStartedAt,
      live: true,
      label: '子代理运行中',
    }
  }

  const persisted = (input.delegationStatus ?? '') as PersistedDelegationStatus | ''
  const now = input.now ?? Date.now()
  const active = now - input.sessionUpdatedAt < DELEGATION_RUNNING_STALE_MS

  if (persisted === 'running') {
    // 没有实时流状态时必须先确认最近仍有活动，避免重启后滞留的 running 伪装成运行中。
    // 起点只从本轮人类输入回退，不用会话年龄冒充耗时。
    return active
      ? { visible: true, phase: 'running', startedAt: input.fallbackStartedAt, live: false, label: '子代理运行中' }
      : { visible: true, phase: 'unknown', live: false, label: '子代理状态待确认' }
  }

  const terminalLabel = persisted ? TERMINAL_LABELS[persisted] : undefined
  if (terminalLabel) {
    return { visible: true, phase: persisted as DelegationRuntimePhase, live: false, label: terminalLabel }
  }

  return HIDDEN
}

export interface DelegationConversationRunStateInput {
  /** 渲染层实时流状态是否在运行。 */
  liveRunning: boolean
  /** 实时流状态记录的运行起点。 */
  liveStartedAt?: number
  /** 由 `resolveDelegationRuntimeDisplay` 推导的运行状态（可能缺失）。 */
  delegation?: DelegationRuntimeDisplay | null
}

export interface DelegationConversationRunState {
  /** 对话区应视为「本轮仍在运行」的流式态。 */
  streaming: boolean
  /** 本轮起点：实时优先，其次委派状态给出的回退起点。 */
  startedAt?: number
  /** true 表示运行态由持久化委派状态兜底（渲染层没有实时流）。 */
  fromDelegationStatus: boolean
}

/**
 * 把「实时流 + 持久化委派状态」收敛成对话区使用的运行态。
 *
 * 为什么要兜底：子会话页可能根本没有实时流（打开时机、跨窗口绑定、事件缺失都发生过）。
 * 只按实时流判断时，过程区会一直折叠、没有 spinner、操作栏提前出现，用户看到的就是
 * 「子会话没有 runtime，一直是折叠态」。委派状态 running 是持久化事实，可以直接驱动
 * 展开与运行指示；时间起点仍优先用实时流，缺失时才用委派回退起点。
 */
export function resolveDelegationConversationRunState(
  input: DelegationConversationRunStateInput,
): DelegationConversationRunState {
  if (input.liveRunning) {
    return { streaming: true, startedAt: input.liveStartedAt, fromDelegationStatus: false }
  }
  if (input.delegation?.visible && input.delegation.phase === 'running') {
    return {
      streaming: true,
      startedAt: input.delegation.startedAt ?? input.liveStartedAt,
      fromDelegationStatus: true,
    }
  }
  return { streaming: false, startedAt: input.liveStartedAt, fromDelegationStatus: false }
}

/** 运行计时的展示文本：小于一分钟按秒，之后按 分:秒。 */
export function formatDelegationElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
