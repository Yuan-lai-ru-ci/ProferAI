/**
 * Shadow Git 的 turn 边界采集入口。
 *
 * 编排器只需要调用两个函数，不需要知道工作区根集合、仓库位置和队列：
 * - `beginWorkspaceShadowTurn`：本轮第一次写文件之前，确保基线存在，并等上一轮的后台采集落盘；
 * - `endWorkspaceShadowTurn`：本轮结束（完成/失败/停止）后补一次 turn-after。
 *
 * 为什么每轮开头都要采 turn-before：
 * 「上一轮 turn-after 就是本轮之前的状态」这个前提只在「用户不在两轮之间动文件」时成立。
 * 用户新建/删除的文件不会被任何 turn-after 看到，会被误判成 Agent 的操作，
 * 回退时就会删掉用户的文件。所以每轮都采（增量 ~200ms），代价换正确性。
 *
 * 全部失败路径只记日志：采集是旁路事实记录，任何异常都不能打断对话。
 */

import { existsSync } from 'node:fs'
import type { AgentWorkspace } from '@profer/shared'
import {
  ShadowJournal,
  appendShadowForkRelation,
  appendShadowTurnAttribution,
  buildShadowTurnAttribution,
  createGitRunner,
  diffShadowCommits,
  pendingWorkspaceShadowCaptures,
  readShadowForkRelation,
  readShadowTurnAttributions,
  runWorkspaceShadowTask,
  waitForWorkspaceShadowIdle,
  type ShadowCaptureResult,
  type ShadowRoot,
  type ShadowTurnEvidenceItem,
} from '@profer/session-store'
import { getAgentWorkspace } from './agent-workspace-manager'
import { findGitPath } from './git-detector'
import {
  captureWorkspaceShadow,
  getWorkspaceShadowDir,
  getWorkspaceShadowJournalPath,
  getWorkspaceShadowRepoDir,
  openWorkspaceShadowRepository,
  resolveWorkspaceShadowRoots,
} from './workspace-shadow-git'

function resolveWorkspace(workspaceId: string | undefined): AgentWorkspace | undefined {
  if (!workspaceId) return undefined
  try {
    return getAgentWorkspace(workspaceId)
  } catch (error) {
    console.warn('[Shadow Git] 解析工作区失败，本轮不采集:', error)
    return undefined
  }
}

function hasBase(workspace: AgentWorkspace): boolean {
  try {
    return existsSync(getWorkspaceShadowRepoDir(workspace.id))
  } catch {
    // 工作区 id 不能作为目录名：当作没有底座，后续 capture 会自行拒绝。
    return false
  }
}

/** 本轮 turn-before 采集出来的边界。缺字段表示这一侧没有可用事实。 */
export interface WorkspaceShadowTurnBaseline {
  /** 本轮开始时工作区的 head 提交；缺失时退回采集自带的 previousCommitId。 */
  commitId?: string
  /** 与 `commitId` 对应的 tree。 */
  treeSha?: string
}

/**
 * 把一次采集结果折成本轮基线。
 *
 * 采集失败 / 没有根（返回 null）/ 结果不 ok 时给空对象：调用方按「没有基线」处理，
 * 行为与引入基线之前完全一致。
 */
function baselineFromCapture(result: ShadowCaptureResult | null | undefined): WorkspaceShadowTurnBaseline {
  if (!result?.ok) return {}
  return {
    ...(result.commitId ? { commitId: result.commitId } : {}),
    ...(result.treeSha ? { treeSha: result.treeSha } : {}),
  }
}

/**
 * 本轮开始：建立首个基线 / 等待上一轮采集落盘。
 *
 * 返回 `undefined` 表示「不需要等」——这一点很重要：调用方用
 * `const pending = begin(...); if (pending) await pending` 的写法，常见路径上
 * 不会引入任何微任务延迟，编排器里「取得执行权后同步可见」的时序保持不变。
 *
 * 只有两种情况会返回 promise：
 * - 工作区还没有底座（首个 turn 必须先把现有内容导入基线）；
 * - 上一轮 turn-after 还在后台跑（必须等它写完，否则两轮写入会被并进同一快照）。
 *
 * 返回的是**本轮 begin 采出来的基线**（head 提交 + tree）。调用方必须把它传回
 * `endWorkspaceShadowTurn`：turn-after 采集自带的 `previousCommitId` 只是「它开始
 * 采集前的 head」，本轮中间任何一次外部采集（启动对账、同 workspace 另一会话轮末、
 * fork-before）都会把它推后，本轮写入就整段落在 diff 之外。
 */
export function beginWorkspaceShadowTurn(
  workspaceId: string | undefined,
  options: { sessionAttachedDirectories?: string[] } = {},
): Promise<WorkspaceShadowTurnBaseline> | undefined {
  const workspace = resolveWorkspace(workspaceId)
  if (!workspace) return undefined
  try {
    if (!hasBase(workspace)) {
      // 首次启用：把工作区现有内容导入基线。失败也只记日志，不阻断本轮。
      return captureWorkspaceShadow({
        workspace,
        reason: 'initial',
        ...(options.sessionAttachedDirectories?.length
          ? { sessionAttachedDirectories: options.sessionAttachedDirectories }
          : {}),
      }).then(
        (result) => baselineFromCapture(result),
        (error: unknown) => {
          console.warn('[Shadow Git] 首个基线采集失败:', error)
          return {}
        },
      )
    }
    // 每轮开头都采一次 turn-before。
    //
    // 曾经用「上一轮 turn-after 就是本轮 before」省掉这次采集，但那个前提不成立：
    // 用户在两轮之间新建/删除的文件不会被任何 turn-after 看到，于是「用户建的文件」
    // 会被算成「Agent 新建」，回退时就会把它删掉（真机验证踩到）。
    // 代价是每轮多一次增量采集（实测 ~200ms），换的是归属与合并都建立在事实之上。
    return captureWorkspaceShadow({
      workspace,
      reason: 'turn-before',
      ...(options.sessionAttachedDirectories?.length
        ? { sessionAttachedDirectories: options.sessionAttachedDirectories }
        : {}),
    }).then(
      (result) => baselineFromCapture(result),
      (error: unknown) => {
        console.warn('[Shadow Git] turn-before 采集失败，本轮归属可能不准:', error)
        return {}
      },
    )
  } catch (error) {
    console.warn('[Shadow Git] turn 前置采集失败，本轮不记录基线:', error)
    return undefined
  }
}

/** 本轮由 runtime 报出的受控写入证据（绝对路径 + 事件流顺序）。 */
export interface ShadowTurnContext {
  /** 会话 id；缺省时不写归属记录（采集照做，只是没有可归属的对象）。 */
  sessionId?: string
  /** turn 身份 = 触发本轮的用户消息 uuid；与 JSONL 消息一一对应，回退时按它定位。 */
  turnId?: string
  runtime?: string
  /** 本轮开始的毫秒时间戳；缺省取采集开始时间。 */
  startedAt?: number
  evidence?: ShadowTurnEvidenceItem[]
  /**
   * 本轮 turn-before 的基线（`beginWorkspaceShadowTurn` 的返回值）。
   *
   * 缺省时退回 turn-after 自带的 `previousCommitId`：老调用路径与采集失败的行为
   * 与引入基线之前完全一致。
   */
  baseline?: WorkspaceShadowTurnBaseline
  /**
   * 本会话的附加目录（绝对路径）。
   *
   * 会话级附加目录只对这个会话可见，因此必须由会话侧传进来：
   * 工作区级配置里没有它们，缺了就会把 Agent 写到附加目录的文件记成「工作区外」。
   */
  sessionAttachedDirectories?: string[]
}

/**
 * 本轮结束：后台补一次 turn-after，并把「树差异 × 写入证据」落成归属记录。
 *
 * 刻意不 await：终态必须尽快交付给 UI；本次采集会排在同一工作区的队列里，
 * 下一个 turn 开始时由 `beginWorkspaceShadowTurn` 等待它完成。
 *
 * 归属记录写在这里而不是编排器里，是因为 before/after 两个边界只有仓库自己
 * 能给出（`previousCommitId` 由采集带出）；但「本轮开始的边界」必须是调用方带回
 * 来的 `baseline`——`previousCommitId` 只是这次采集开始前的 head，本轮中间发生过
 * 外部采集时它已经不是本轮 before 了。
 */
export function endWorkspaceShadowTurn(workspaceId: string | undefined, context: ShadowTurnContext = {}): void {
  const workspace = resolveWorkspace(workspaceId)
  if (!workspace) return
  const startedAt = context.startedAt ?? Date.now()
  // 采集与归属记录必须是**同一个队列任务**：记录一部分落在队列外时，
  // 「队列空闲」不再等价于「这个 turn 已经记完」，进程退出或下一轮等待都可能
  // 看到半个 turn（有提交、没有归属），而这正是回退最依赖的那条链。
  void runWorkspaceShadowTask(workspace.id, async () => {
    const repository = await openWorkspaceShadowRepository({ workspace })
    if (!repository) return
    // 根集合在这里解析一次并原样交给采集与记录：会话级附加目录可能随时增删，
    // 采一份、记另一份会让归属记录里的路径含义失真。
    const roots = resolveWorkspaceShadowRoots(workspace, {
      ...(context.sessionAttachedDirectories ? { sessionAttachedDirectories: context.sessionAttachedDirectories } : {}),
    })
    if (roots.length === 0) return
    const result = await repository.captureExclusive({ reason: 'turn-after', roots })
    const sessionId = context.sessionId
    // 没有会话身份就没有可归属的对象：采集照做（工作区历史仍需要这条边界），
    // 只是不写 turn 记录，避免造出一批「谁都不是」的假归属。
    if (!sessionId) return
    await recordTurnAttribution({ workspace, sessionId, result, context, startedAt, roots })
  }).catch((error: unknown) => {
    console.warn('[Shadow Git] turn 结束采集失败:', error)
  })
}

interface RecordTurnAttributionInput {
  workspace: AgentWorkspace
  sessionId: string
  result: ShadowCaptureResult
  context: ShadowTurnContext
  startedAt: number
  roots: ShadowRoot[]
}

/**
 * 上一个边界的根集合。
 *
 * 会话级附加目录可能在两次 turn 之间增删。只有拿到「上一次看了哪些根」，才能区分
 * 「文件是新纳入采集的」和「文件真的新增/删除」——前者绝不能当删除证据。
 * 边界 commit 对应的 journal 条目里正好有这份快照，不需要额外存储。
 */
function resolvePreviousRootIds(workspace: AgentWorkspace, commitId: string | undefined): string[] | undefined {
  if (!commitId) return undefined
  try {
    const journal = ShadowJournal.open(getWorkspaceShadowJournalPath(workspace.id), workspace.id)
    const entries = journal.list()
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (entry?.commitId === commitId) return entry.roots.map((root) => root.rootId)
    }
  } catch (error) {
    console.warn('[Shadow Git] 读取上一次根集合失败，跳过根增删判定:', error)
  }
  return undefined
}

/**
 * 分叉关系只在分叉后的**第一条** turn 记录上带。
 *
 * 后续 turn 的归属与分叉无关，重复写只会让记录变噪；而关系本身已经在
 * forks.jsonl 里持久化，任何时候都能查回来。
 */
function resolveForkOf(shadowDir: string, sessionId: string, hasEarlierRecords: boolean): {
  sourceSessionId: string
  commitId?: string
  upToMessageUuid?: string
} | undefined {
  if (hasEarlierRecords) return undefined
  const relation = readShadowForkRelation(shadowDir, sessionId)
  if (!relation) return undefined
  return {
    sourceSessionId: relation.sourceSessionId,
    ...(relation.commitId ? { commitId: relation.commitId } : {}),
    ...(relation.upToMessageUuid ? { upToMessageUuid: relation.upToMessageUuid } : {}),
  }
}

async function recordTurnAttribution(input: RecordTurnAttributionInput): Promise<void> {
  const { workspace, result, context } = input
  const shadowDir = getWorkspaceShadowDir(workspace.id)
  // 本轮 before：优先用 begin 带回来的基线，缺失时退回采集自带的 previousCommitId。
  // base 只算一次：diff 与 previousRootIds 必须看同一个边界，否则根增删判定会和
  // 文件变化对不上（两套边界各自看着像真的，合起来却无解）。
  const beforeCommitId = context.baseline?.commitId ?? result.previousCommitId
  const beforeTreeSha = context.baseline?.treeSha ?? result.previousTreeSha

  let diff: Awaited<ReturnType<typeof diffShadowCommits>> | null = null
  let note: string | undefined
  if (!result.ok) {
    note = result.error ?? '采集失败'
  } else if (!result.commitId) {
    note = '缺少结束边界'
  } else {
    const gitPath = findGitPath()
    if (!gitPath) {
      note = 'git 不可用'
    } else {
      const runner = createGitRunner({ gitPath })
      diff = await diffShadowCommits(
        runner,
        getWorkspaceShadowRepoDir(workspace.id),
        beforeCommitId,
        result.commitId,
      )
      if (!diff.ok) note = diff.error
    }
  }

  let earlierRecords: number
  let forkOf: ReturnType<typeof resolveForkOf>
  try {
    earlierRecords = readShadowTurnAttributions(shadowDir, { sessionId: input.sessionId }).length
    forkOf = resolveForkOf(shadowDir, input.sessionId, earlierRecords > 0)
  } catch (error) {
    console.warn('[Shadow Git] 读取既有归属记录失败，按无历史处理:', error)
    forkOf = undefined
  }

  const record = buildShadowTurnAttribution({
    workspaceId: workspace.id,
    sessionId: input.sessionId,
    // turnId 优先用用户消息 uuid：它是唯一能和 JSONL 消息对上的身份，
    // 采集 id 只能兜底满足「至少能定位到一次采集」。
    turnId: context.turnId ?? result.captureId,
    turnIdSource: context.turnId ? 'user-message' : 'capture',
    runtime: context.runtime ?? 'unknown',
    startedAt: input.startedAt,
    endedAt: Date.now(),
    ...(beforeCommitId ? { beforeCommitId } : {}),
    ...(result.commitId ? { afterCommitId: result.commitId } : {}),
    ...(beforeTreeSha ? { beforeTreeSha } : {}),
    ...(result.treeSha ? { afterTreeSha: result.treeSha } : {}),
    diff: diff && diff.ok ? diff.entries : null,
    evidence: context.evidence ?? [],
    roots: input.roots,
    ...((): { previousRootIds?: string[] } => {
      const previousRootIds = resolvePreviousRootIds(workspace, beforeCommitId)
      return previousRootIds ? { previousRootIds } : {}
    })(),
    partial: result.roots.some((root) => root.partial),
    ...(note ? { note } : {}),
    ...(forkOf ? { forkOf } : {}),
  })

  appendShadowTurnAttribution(shadowDir, record)
}

/** 分叉边界：从哪个会话、哪个工作区状态分出去。 */
export interface RecordWorkspaceShadowForkInput {
  sourceSessionId: string
  newSessionId: string
  /** 源会话的工作区；缺省时无法定位底座，只跳过不报错。 */
  workspaceId?: string | null
  sessionAttachedDirectories?: string[]
  upToMessageUuid?: string
}

/**
 * 记录一次分叉。
 *
 * 分叉只动 Profer 自己的会话数据（已在采集排除范围里），工作区文件不变，
 * 所以「分叉之后采」和「分叉之前采」是同一棵树。放在分叉成功之后做的原因：
 * 采集失败不该影响分叉本身的结果。
 *
 * 关系单独落盘、不等新会话第一条 turn 再回填：新会话可能一直不发言。
 */
export function recordWorkspaceShadowFork(input: RecordWorkspaceShadowForkInput): void {
  const workspace = resolveWorkspace(input.workspaceId ?? undefined)
  if (!workspace) return
  const at = Date.now()
  void runWorkspaceShadowTask(workspace.id, async () => {
    let commitId: string | undefined
    try {
      const repository = await openWorkspaceShadowRepository({ workspace })
      if (repository) {
        const roots = resolveWorkspaceShadowRoots(workspace, {
          ...(input.sessionAttachedDirectories ? { sessionAttachedDirectories: input.sessionAttachedDirectories } : {}),
        })
        if (roots.length > 0) {
          const result = await repository.captureExclusive({ reason: 'fork-before', roots })
          if (result.ok && result.commitId) commitId = result.commitId
        }
      }
    } catch (error) {
      // 关系比边界更重要：采集失败仍然要写 forks.jsonl，否则新会话永远不知道自己是分叉来的。
      console.warn('[Shadow Git] 分叉边界采集失败，仅记录关系:', error)
    }
    appendShadowForkRelation(getWorkspaceShadowDir(workspace.id), {
      schemaVersion: 1,
      workspaceId: workspace.id,
      sourceSessionId: input.sourceSessionId,
      newSessionId: input.newSessionId,
      ...(commitId ? { commitId } : {}),
      ...(input.upToMessageUuid ? { upToMessageUuid: input.upToMessageUuid } : {}),
      at,
    })
  }).catch((error: unknown) => {
    console.warn('[Shadow Git] 记录分叉关系失败:', error)
  })
}
