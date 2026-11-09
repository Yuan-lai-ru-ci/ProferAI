/**
 * 工作区回退执行入口（Phase 3）。
 *
 * 编排顺序刻意固定成「先留保护快照，再写盘」：
 * 1. 读该 turn 的归属记录（含当时的根快照）；
 * 2. 采一次 `rewind-before` 作为保护快照——**采不到就不写盘**；
 * 3. journal 记 pending；
 * 4. 执行逆向 patch；
 * 5. journal 记结论；
 * 6. 写盘成功后采一次 `rewind-after`，让历史里留下「回退发生过」这个事实。
 *
 * 第 2 步是整套回退的安全底线：没有保护快照就动手，一旦判定出错就没有退路。
 * 第 3 步是崩溃可见性：进程在 4 中间被杀，下次启动能明确知道有一次回退没走完。
 */

import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentWorkspace } from '@profer/shared'
import {
  appendShadowRestoreEntry,
  createGitRunner,
  findShadowTurnAttribution,
  findUnfinishedRestore,
  restoreShadowTurnChanges,
  runWorkspaceShadowTask,
  type ShadowRestoreEntry,
} from '@profer/session-store'
import { getAgentWorkspace } from './agent-workspace-manager'
import { findGitPath } from './git-detector'
import {
  getWorkspaceShadowDir,
  getWorkspaceShadowRepoDir,
  openWorkspaceShadowRepository,
  resolveWorkspaceShadowRoots,
} from './workspace-shadow-git'
import { cleanupRestoreTemp } from '@profer/session-store'

export interface RestoreWorkspaceShadowTurnInput {
  workspaceId: string
  sessionId: string
  /** turn 身份 = 触发该 turn 的用户消息 uuid（归属记录的 turnId）。 */
  turnId: string
  /** true = 只算计划不写盘；保护快照也会跳过。 */
  dryRun?: boolean
}

export interface RestoreWorkspaceShadowTurnResult {
  ok: boolean
  restoreId: string
  counts: { restored: number; deleted: number; kept: number; skipped: number }
  entries: ShadowRestoreEntry[]
  protectionCommitId?: string
  error?: string
}

function emptyCounts(): { restored: number; deleted: number; kept: number; skipped: number } {
  return { restored: 0, deleted: 0, kept: 0, skipped: 0 }
}

/**
 * 执行一个 turn 的文件回退。
 *
 * 失败时返回 `ok:false` 而不是 throw：调用方（Phase 4 的回退事务）需要把
 * 「文件没回退成功」和「对话已经截断」分开处理，异常会把两者混在一起。
 */
export async function restoreWorkspaceShadowTurn(
  input: RestoreWorkspaceShadowTurnInput,
): Promise<RestoreWorkspaceShadowTurnResult> {
  const restoreId = randomUUID()
  let workspace: AgentWorkspace | undefined
  try {
    workspace = getAgentWorkspace(input.workspaceId)
  } catch (error) {
    return { ok: false, restoreId, counts: emptyCounts(), entries: [], error: `工作区不存在：${String(error)}` }
  }
  if (!workspace) {
    return { ok: false, restoreId, counts: emptyCounts(), entries: [], error: '工作区不存在' }
  }

  try {
    return await runWorkspaceShadowTask(workspace.id, async () => {
      const shadowDir = getWorkspaceShadowDir(workspace.id)
      const record = findShadowTurnAttribution(shadowDir, input.sessionId, input.turnId)
      if (!record) {
        return {
          ok: false,
          restoreId,
          counts: emptyCounts(),
          entries: [],
          error: '找不到该轮次的归属记录，无法确定回退边界',
        }
      }

      // 上一次回退没走完：先把这条事实补记完整，避免 journal 永远停在 pending。
      const unfinished = findUnfinishedRestore(shadowDir)
      if (unfinished) {
        appendShadowRestoreEntry(shadowDir, {
          ...unfinished,
          status: 'interrupted',
          completedAt: Date.now(),
          error: unfinished.error ?? '进程在回退过程中退出，未确认是否写盘完成',
        })
        console.warn(`[Shadow Git] 检测到未完成回退：${unfinished.restoreId}（${unfinished.sessionId}/${unfinished.turnId}）`)
      }

      const gitPath = findGitPath()
      if (!gitPath) {
        return { ok: false, restoreId, counts: emptyCounts(), entries: [], error: 'git 不可用' }
      }

      // 没有变化就没有要回退的东西：早退比走一遍采集+判定更诚实（不产生空提交）。
      if (record.changes.length === 0) {
        return { ok: true, restoreId, counts: emptyCounts(), entries: [] }
      }

      // 根路径以归属记录里的快照为准：会话级附加目录可能早已变更，
      // 用「现在的配置」去解释当时的路径会指向另一个目录。
      // 记录缺失快照时就无法把 `roots/<rootId>/a.ts` 还原成真实路径，宁可拒绝。
      if (record.roots.length === 0) {
        return {
          ok: false,
          restoreId,
          counts: emptyCounts(),
          entries: [],
          error: '归属记录缺少根路径快照，无法安全定位文件',
        }
      }
      const rootPaths = new Map(record.roots.map((root) => [root.rootId, root.rootPath]))

      let protectionCommitId: string | undefined
      if (!input.dryRun) {
        const repository = await openWorkspaceShadowRepository({ workspace })
        if (!repository) {
          return { ok: false, restoreId, counts: emptyCounts(), entries: [], error: '工作区底座不可用' }
        }
        const roots = resolveWorkspaceShadowRoots(workspace)
        if (roots.length === 0) {
          return { ok: false, restoreId, counts: emptyCounts(), entries: [], error: '没有可采集的根目录' }
        }
        const protection = await repository.captureExclusive({ reason: 'rewind-before', roots })
        if (!protection.ok) {
          // 没有保护快照就绝不写盘：这是整套回退唯一的退路。
          return {
            ok: false,
            restoreId,
            counts: emptyCounts(),
            entries: [],
            error: `保护快照失败，拒绝写盘：${protection.error ?? '未知原因'}`,
          }
        }
        protectionCommitId = protection.commitId || undefined
      }

      const tempDir = join(shadowDir, 'tmp', `restore-${restoreId}`)
      const runner = createGitRunner({ gitPath })
      const runRestore = async (dryRun: boolean) =>
        restoreShadowTurnChanges({
          runner,
          repoDir: getWorkspaceShadowRepoDir(workspace.id),
          tempDir,
          record,
          rootPaths,
          ...(dryRun ? { dryRun: true } : {}),
        })

      let result
      try {
        if (!input.dryRun) {
          // 先把计划落进 journal 再动手：进程在写盘中途被杀时，
          // 「原本打算动哪些文件」是恢复现场唯一能拿到的线索。
          // 代价是每次回退多跑一遍判定（只读，不写盘），换的是可诊断性。
          const plan = await runRestore(true)
          const startedAt = Date.now()
          appendShadowRestoreEntry(shadowDir, {
            schemaVersion: 1,
            restoreId,
            workspaceId: workspace.id,
            sessionId: input.sessionId,
            turnId: input.turnId,
            status: 'pending',
            startedAt,
            ...(protectionCommitId ? { protectionCommitId } : {}),
            outcomes: plan.entries.map((entry) => ({ path: entry.path, action: entry.action, reason: entry.reason })),
          })
        }
        result = await runRestore(input.dryRun === true)
      } catch (error) {
        // 单文件错误已在 reverse-patch 内部降级；能走到这里说明是整体故障（例如 git 崩了），
        // 仍要写一条 failed，否则 journal 会永远停在 pending。
        result = {
          ok: false,
          entries: [],
          counts: emptyCounts(),
          error: error instanceof Error ? error.message : String(error),
        }
      } finally {
        cleanupRestoreTemp({ tempDir })
      }

      if (!input.dryRun) {
        appendShadowRestoreEntry(shadowDir, {
          schemaVersion: 1,
          restoreId,
          workspaceId: workspace.id,
          sessionId: input.sessionId,
          turnId: input.turnId,
          status: result.ok ? 'completed' : 'failed',
          startedAt: Date.now(),
          completedAt: Date.now(),
          ...(protectionCommitId ? { protectionCommitId } : {}),
          outcomes: result.entries.map((entry) => ({ path: entry.path, action: entry.action, reason: entry.reason })),
          counts: result.counts,
          ...(result.error ? { error: result.error } : {}),
        })

        // 历史里留下「回退发生过」：否则下一次 turn 的 before 边界会跨过这次回退，
        // 看起来像「Agent 改完之后又变了」，归属会被算到来回折腾的那一轮上。
        if (result.counts.restored + result.counts.deleted > 0) {
          try {
            const repository = await openWorkspaceShadowRepository({ workspace })
            const roots = resolveWorkspaceShadowRoots(workspace)
            if (repository && roots.length > 0) {
              await repository.captureExclusive({ reason: 'rewind-after', roots })
            }
          } catch (error) {
            console.warn('[Shadow Git] 回退后的边界采集失败（不影响回退结果）:', error)
          }
        }
      }

      return {
        ok: result.ok,
        restoreId,
        counts: result.counts,
        entries: result.entries,
        ...(protectionCommitId ? { protectionCommitId } : {}),
        ...(result.error ? { error: result.error } : {}),
      }
    })
  } catch (error) {
    return {
      ok: false,
      restoreId,
      counts: emptyCounts(),
      entries: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
