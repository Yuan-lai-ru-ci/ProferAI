/**
 * agent-session-title-naming —— 会话「自动命名窗口」的**唯一实现**（旧编排链与新 runtime 链共用）。
 *
 * ## 为什么要有这个模块
 *
 * 自动标题在两条链上必须完全一致：同一判据、同一时机、同一去重与重试语义。此前它只存在于
 * `agent-orchestrator.ts` 的私有方法里（`autoGenerateTitle` + `collectSessionTitleSources`），
 * 新 runtime 链路（`agent-runtime-entry.ts` 及其四条入口）完全没有这一能力 —— 桌面切到新链后
 * 侧边栏标题会停在第 1 条用户消息（GAP-D1）。
 *
 * 做法不是在新链「再写一份差不多的」，而是把**窗口编排 + 来源收集**整体移到这里，两条链都调用
 * 同一份实现，只把「宿主事实」以端口注入：
 *
 * | 判据 / 步骤 | 唯一来源 |
 * |---|---|
 * | 窗口状态机（何时生成 / 生成几次 / 何时锁定） | `title-generation.ts` 的 `planTitleWindow` / `preflightTitleWindow` |
 * | 来源过滤（注入块 / 纯命令 / 寒暄 / 去重 / 限长限条数） | `title-generation.ts` 的 `collectTitleSources` |
 * | 转录扫描与探索分支锚点 | **本模块**的 `collectSessionTitleSources` |
 * | 尝试次数预占、人工改名保护、锁定写回 | **本模块**的 `runSessionTitleNaming` |
 *
 * 命名上刻意与 `title-generation.ts` 区分：后者是「纯判据」（无会话、无 IO、无副作用，Chat 与
 * Agent 共用），本模块是「会话级窗口编排」（读转录、写元数据、投影标题事件）。
 *
 * ## 与旧链的逐条等价
 *
 * - **触发时机**：正常完成一轮之后**立即后台启动**，不阻塞终态广播（标题事件可以晚于
 *   `run_complete` / `STREAM_COMPLETE` 到达）；用户停止 / result 携带 errors / 运行失败都不生成。
 * - **调用次数**：最多 `TITLE_REFINE_MAX_ATTEMPTS` 次；失败也算一次（先预占再生成），
 *   避免渠道不可用时每轮都烧一次请求。
 * - **锁定条件**：来源条数达到 `TITLE_LOCK_MIN_SOURCES`（第二条有效用户消息）即定稿；
 *   人工改名 / 次数用尽也会把窗口关闭（写 `titleLockedAt`）并永久退出自动流程。
 * - **覆盖保护**：生成期间用户改名 / 已定稿 → 丢弃本次结果；探索分支首次命名允许从
 *   「父标题 (fork)」改写。
 * - **失败不阻断**：整个函数内部兜底，任何异常只记日志；调用方不需要 try/catch 也不会被拖垮。
 *
 * ## 边界
 *
 * 不读渠道、不建 HTTP 请求、不落盘、不碰 Electron：生成器（`generate`）、元数据读写
 * （`getMeta` / `updateMeta`）、转录读取（`readMessages`）与投影出口（`onTitleUpdated`）全部由
 * 调用方注入。因此本模块可被 headless / 桌面 / 测试直接驱动，也不会把 Electron 或文件系统
 * 带进 `agent-runtime-entry.ts` 的依赖图。
 */

import type { AgentGenerateTitleInput, AgentSessionMeta, SDKMessage, SDKUserMessage } from '@profer/shared'
import { extractUserText, groupIntoTurns, isUserInputMessage } from '@profer/session-core'
import { collectTitleSources, planTitleWindow, preflightTitleWindow } from './session-title-policy'

/** 本模块的日志出口（默认 `console`；测试可注入记录器）。 */
export interface SessionTitleNamingLogger {
  log(message: string, ...rest: unknown[]): void
  warn(message: string, ...rest: unknown[]): void
}

/** 两条链各自的日志标签（旧链为 `[Agent 编排]`），保证日志仍可归因到具体链路。 */
export type SessionTitleNamingLogTag = string

/** `collectSessionTitleSources` 的宿主事实。 */
export interface SessionTitleSourceInput {
  sessionId: string
  /** 会话转录读取；缺省或抛错时退化为「只用本轮消息」，与旧链同一兜底语义。 */
  readMessages?(sessionId: string): readonly SDKMessage[]
  /** 会话元数据（探索分支需要 `explorationParentSessionId` / `explorationSourceMessageId` 定位锚点）。 */
  meta: AgentSessionMeta | undefined
  /** 本轮用户消息；作为来源列表的兜底文本（旧链 `input.titleSourceText ?? userMessage`）。 */
  fallbackMessage: string
  logTag: SessionTitleNamingLogTag
  log?: SessionTitleNamingLogger
}

/**
 * 从会话转录里收集「有信息量」的用户消息。
 *
 * 与只拿当前这条消息命名不同，窗口把会话最初几轮的有效用户消息攒在一起，让模型能在用户还没说清
 * 意图时先给一个临时名，等意图明确后再精修。寒暄（`hi`）、确认（`提交吧`）与纯斜杠命令（`/compact`）
 * 不计入，否则就会重现历史里的 `hi`、`/compact`、`ok，现在继续转战…` 这类标题。
 *
 * Pi 探索分支的转录里含 fork 前复制的父会话历史，必须从分叉锚点之后开始取，否则会把父会话的首条
 * 消息当成本分支的意图；锚点找不到时退回只看本次消息。
 */
export function collectSessionTitleSources(input: SessionTitleSourceInput): string[] {
  const log = input.log ?? console
  const { sessionId, meta, fallbackMessage, logTag } = input
  let texts: string[] = []
  try {
    const messages = [...(input.readMessages?.(sessionId) ?? [])]
    const anchorId = meta?.explorationParentSessionId ? meta.explorationSourceMessageId : undefined
    let candidateMessages = messages

    // 普通会话不需要先分组；直接扫描持久化消息，避免一条损坏/旧格式记录
    // 让整个标题收集失败。只有探索分支需要分组来定位 fork 锚点。
    if (anchorId) {
      try {
        const groups = groupIntoTurns(messages)
        const anchorIndex = groups.findIndex((group) => group.type === 'assistant-turn'
          && group.assistantMessages.some((message) => message.uuid === anchorId))
        if (anchorIndex >= 0) {
          candidateMessages = groups
            .slice(anchorIndex + 1)
            .filter((group): group is Extract<typeof group, { type: 'user' }> => group.type === 'user')
            .map((group) => group.message)
        } else {
          log.warn(`${logTag} 探索分支命名未找到分叉锚点，改为扫描当前会话消息`)
        }
      } catch (error) {
        log.warn(`${logTag} 会话分组失败，改为直接扫描标题来源:`, error)
      }
    }

    const extractCandidate = (message: SDKMessage): string | null => {
      if (message.type !== 'user') return null
      try {
        return isUserInputMessage(message as SDKUserMessage)
          ? extractUserText(message as SDKUserMessage)
          : null
      } catch {
        // 历史消息可能来自旧 SDK 或中断写入；坏记录不应遮蔽其它用户消息。
        return null
      }
    }

    texts = candidateMessages
      .map(extractCandidate)
      .filter((text): text is string => text !== null)

    // 锚点之后没有可用消息时，兼容只有 user 消息已落盘或锚点记录异常的旧分支。
    if (texts.length === 0 && anchorId) {
      texts = messages
        .map(extractCandidate)
        .filter((text): text is string => text !== null)
    }
  } catch (error) {
    log.warn(`${logTag} 读取会话转录用于命名失败，改为仅用本次消息:`, error)
    texts = []
  }
  if (fallbackMessage) texts.push(fallbackMessage)
  const sources = collectTitleSources(texts)
  log.log(`${logTag} 标题来源收集完成:`, { sessionId, sourceCount: sources.length })
  return sources
}

/** 自动命名窗口的宿主事实（两条链注入自己的实现，判据本身不注入）。 */
export interface SessionTitleNamingPorts {
  sessionId: string
  /**
   * 本轮用户消息（旧链：`input.titleSourceText ?? userMessage`）。
   *
   * 既是来源收集的兜底文本，也是无来源时传给生成器的 `userMessage`。
   */
  userMessage: string
  channelId: string
  modelId: string
  /**
   * 该链路的默认标题（Agent 为 `DEFAULT_SESSION_TITLE`）。
   *
   * 与 `planTitleWindow` 的「人工命名」判定同源：不等于默认标题且从未由本机制写过，
   * 视为用户自己起的名字，窗口关闭且永不覆盖。
   */
  defaultTitle: string
  /** 会话元数据读取（旧链 `sessionPort.getMeta`）。 */
  getMeta(sessionId: string): AgentSessionMeta | undefined
  /** 会话元数据写入（旧链 `sessionPort.updateMeta`）。 */
  updateMeta(sessionId: string, patch: Partial<AgentSessionMeta>): void
  /** 会话转录读取（旧链 `sessionPort.getMessages`）；缺省只用本轮消息。 */
  readMessages?(sessionId: string): readonly SDKMessage[]
  /** 标题生成器（旧链 `AgentOrchestrator.generateTitle`）；测试注入替身，不调真实模型。 */
  generate(input: AgentGenerateTitleInput): Promise<string | null>
  /** 标题更新投影（旧链 `callbacks.onTitleUpdated`）。 */
  onTitleUpdated(title: string): void
  /** 日志标签（旧链 `[Agent 编排]`）。 */
  logTag: SessionTitleNamingLogTag
  log?: SessionTitleNamingLogger
}

/**
 * 自动命名窗口：按旧链同一判据决定是否生成、生成几次、何时锁定，并投影标题更新。
 *
 * 调用方约定：只在**一轮正常完成之后**调用，且**不得 await 在终态广播之前**——
 * 标题模型慢请求/重试会把「输出已结束」拖成「仍在运行」。终态先走，本函数在后台完成后再投影标题。
 * 函数本身不抛错：一切失败都只记日志并放弃本轮命名，绝不阻断运行。
 *
 * @returns 是否真的投递了一次标题更新（供入口 / 测试断言时机与去重，不改变任何判定）。
 */
export async function runSessionTitleNaming(ports: SessionTitleNamingPorts): Promise<boolean> {
  const log = ports.log ?? console
  const { sessionId, logTag } = ports
  const meta = ports.getMeta(sessionId)
  if (!meta) return false

  try {
    const isExplorationFirstNaming = Boolean(
      meta.explorationParentSessionId && !meta.explorationTitleInitializedAt,
    )
    // Pi 探索/分叉分支继承「父标题 (fork)」，需要给分支自己命名一次。
    const windowInput = {
      title: meta.title,
      defaultTitle: ports.defaultTitle,
      titleAutoGeneratedAt: meta.titleAutoGeneratedAt,
      titleRefineAttempts: meta.titleRefineAttempts,
      titleLockedAt: meta.titleLockedAt,
      allowNonDefaultTitle: isExplorationFirstNaming,
    }

    // 先做只看元数据的预判：已定稿 / 人工命名 / 次数用尽都不需要读转录。
    const preflight = preflightTitleWindow(windowInput)
    if (preflight) {
      if (preflight.action === 'lock') {
        log.log(`${logTag} 自动命名窗口关闭（${preflight.reason}）`)
        ports.updateMeta(sessionId, { titleLockedAt: Date.now() })
      }
      return false
    }

    const sources = collectSessionTitleSources({
      sessionId,
      meta,
      fallbackMessage: ports.userMessage,
      logTag,
      ...(ports.readMessages ? { readMessages: ports.readMessages } : {}),
      ...(ports.log ? { log: ports.log } : {}),
    })
    const decision = planTitleWindow({ ...windowInput, sourceCount: sources.length })
    if (decision.action !== 'generate') {
      // 此处只可能是「无有效来源」：不消耗调用次数，等下一个有内容的轮次。
      log.log(`${logTag} 标题来源无信息量，跳过本次自动命名`)
      return false
    }

    // 先记尝试次数：生成失败也算一次，避免在渠道不可用时每轮都烧一次请求。
    // 分支初始化标记与尝试次数同期写入：它只在真的要命名时才代表「分支标题已初始化」，
    // 否则一个寒暄开场的分支会被误判为已命名而卡在「父标题 (fork)」上。
    ports.updateMeta(sessionId, {
      titleRefineAttempts: decision.attempts,
      ...(isExplorationFirstNaming ? { explorationTitleInitializedAt: Date.now() } : {}),
    })

    const title = await ports.generate({
      userMessage: sources[0] ?? ports.userMessage,
      channelId: ports.channelId,
      modelId: ports.modelId,
      contextMessages: sources,
    })
    if (!title) return false

    // 标题请求是异步的；期间用户可能手动重命名或已定稿，不能覆盖用户决定。
    const latestMeta = ports.getMeta(sessionId)
    if (!latestMeta || latestMeta.titleLockedAt) return false
    // 探索分支首次命名允许标题从「父标题 (fork)」变为新名字，其余情况要求标题未被改动。
    const titleUntouched = isExplorationFirstNaming
      ? latestMeta.title === meta.title && !latestMeta.titleAutoGeneratedAt
      : latestMeta.title === meta.title
        && (latestMeta.titleAutoGeneratedAt ?? null) === (meta.titleAutoGeneratedAt ?? null)
    if (!titleUntouched) return false

    const lockNow = decision.lockAfterApply
    ports.updateMeta(sessionId, {
      title,
      titleAutoGeneratedAt: Date.now(),
      ...(lockNow ? { titleLockedAt: Date.now() } : {}),
    })
    ports.onTitleUpdated(title)
    log.log(`${logTag} 自动标题生成完成: "${title}"（来源 ${sources.length} 条，${lockNow ? '已定稿' : '待精修'}）`)
    return true
  } catch (error) {
    log.warn(`${logTag} 自动标题生成失败:`, error)
    return false
  }
}
