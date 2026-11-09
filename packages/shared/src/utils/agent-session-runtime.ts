import type { AgentSessionMeta } from '../types/agent'
import type { AgentRuntime } from '../types/agent-provider'
import { isChannelEnabledForRuntime, type Channel } from '../types/channel'

/** 请求未取得运行权，service 必须拒绝调用，不能向已有 owner 广播假终态。 */
export class AgentSessionRuntimeMismatchError extends Error {
  readonly code = 'AGENT_SESSION_RUNTIME_MISMATCH'
  constructor(expected: AgentRuntime, received: AgentRuntime) {
    super(`AGENT_SESSION_RUNTIME_MISMATCH: 会话固定使用 ${expected}，请求使用 ${received}；请新建对应内核的会话`)
    this.name = 'AgentSessionRuntimeMismatchError'
  }
}

/** 新会话首次运行前可选内核；旧正式会话缺省锁定，不迁移原生恢复资产。 */
export function canSelectAgentSessionRuntime(session: Partial<AgentSessionMeta> | undefined): boolean {
  if (!session || session.agentRuntimeLocked === true) return false
  if (session.agentRuntimeLocked !== false && session.draft !== true) return false
  return !(
    session.sdkSessionId || session.piSessionFile
    || Object.keys(session.piEntryBindings ?? {}).length
    || Object.keys(session.piFileCheckpoints ?? {}).length
    || session.forkSourceSdkSessionId || session.forkSourceDir || session.resumeAtMessageUuid
    || session.parentSessionId || session.explorationParentSessionId || session.sourceAutomationId
  )
}

/**
 * 同一 session 已有 run 持有执行权；本次请求未取得运行权。
 *
 * 它与 `AgentSessionRuntimeMismatchError` 同属「请求被拒绝」而不是 owner run 的
 * 流式错误或终态：调用方不得向该 session 广播 run_error / run_complete，也不得落盘。
 *
 * 定义在 shared（而非某个宿主）是因为新旧两条执行链都要抛它、宿主入口都要按
 * `instanceof` 识别它；字符串比较不能作为拒绝判据。
 */
export class AgentRunAlreadyActiveError extends Error {
  readonly code = 'AGENT_RUN_ALREADY_ACTIVE'

  constructor(readonly stopping: boolean) {
    super(`AGENT_RUN_ALREADY_ACTIVE: ${stopping ? 'Agent 正在停止，请稍候再试' : '上一条消息仍在处理中，请稍候再试'}`)
    this.name = 'AgentRunAlreadyActiveError'
  }
}

export const AGENT_SESSION_RUNTIME_LOCKED_MESSAGE = '此会话的 Agent 内核已固定；如需使用另一内核，请新建会话。'

/**
 * 会话内核与「所选渠道」不兼容时返回用户可见文案；兼容（或无法判定）返回 `null`。
 *
 * 这是「一个会话只能有一种内核」的唯一判据：内核由会话固定，渠道只是执行载体，
 * 因此渠道没有为该内核开启时，这条消息根本不能发出去——否则 Pi 会话会带着
 * Claude 渠道的凭据去跑，反之亦然，历史与原生 transcript 再也对不上。
 *
 * 文案刻意不出现 runtime / artifact 这类内部词：用户看到的是「引擎」，
 * 且必须读到「新建会话」这条唯一可行的出路。
 */
export function resolveAgentRuntimeChannelConflict(input: {
  /** 会话固定的内核。 */
  sessionRuntime: AgentRuntime
  /** 已解析到的渠道；`undefined` 表示渠道 id 查不到（已删除的渠道）。 */
  channel: Pick<Channel, 'provider' | 'enabled' | 'agentExperimentalEnabled' | 'agentRuntimes' | 'name'> | undefined
  /** 是否真的指定了渠道；未指定（如纯标题生成）时不参与判定。 */
  channelId?: string | undefined
}): string | null {
  // 本函数只判定「内核是否对得上」这一个轴。渠道缺失/停用是另一类失败，已有各自的
  // preflight（旧链 `channel_not_found`、新链凭据解析）负责报出，不能在这里越权判死：
  // 否则任何拿不到渠道注册表的宿主（隔离测试、标题生成、渠道刚被删除）都会被误拦。
  if (!input.channelId || !input.channel) return null
  const sessionRuntime = input.sessionRuntime
  const sessionLabel = runtimeDisplayName(sessionRuntime)
  const channel = input.channel
  const channelLabel = channel.name ? `「${channel.name}」` : ''
  if (!channel.enabled) return null
  if (isChannelEnabledForRuntime(channel, sessionRuntime)) return null
  const otherRuntime: AgentRuntime = sessionRuntime === 'pi' ? 'claude' : 'pi'
  // 渠道仅为另一内核开启：给出「谁不支持谁」的完整因果，不让用户猜。
  if (isChannelEnabledForRuntime(channel, otherRuntime)) {
    return `当前会话使用 ${sessionLabel} 引擎，所选渠道${channelLabel}只支持 ${runtimeDisplayName(otherRuntime)} 引擎；请新建会话后再选择`
  }
  return `当前会话使用 ${sessionLabel} 引擎，所选渠道${channelLabel}没有开启 Agent 对话；请重新选择模型`
}

/** 用户可见的内核名称；不要在这里暴露内部标识。 */
export function runtimeDisplayName(runtime: AgentRuntime): string {
  return runtime === 'pi' ? 'Pi' : 'Claude'
}
