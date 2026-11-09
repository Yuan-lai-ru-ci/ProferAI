/**
 * 启动时的 Shadow Git 对账。
 *
 * 只做一件事：应用启动后，对**已经建立过底座**的工作区再采一次状态，把上次退出后
 * 用户或外部进程改动过的文件补进历史。这是 Phase 1 里成本最低、风险最低的接入点：
 * - 不动任何回退 / 重新生成逻辑，采集纯旁路；
 * - 增量索引让「没变化」的工作区只需几百毫秒；tree 没变时也不会产生空提交；
 * - 首次建立底座仍属于「工作区首次启用」的显式路径，不在启动时对所有工作区全量哈希
 *   （否则装了很多大项目的用户每次开应用都要付一遍全量扫描）。
 *
 * 失败一律只记日志：底座不可用不能影响用户打开界面。
 */

import { existsSync } from 'node:fs'
import { listAgentWorkspaces } from './agent-workspace-manager'
import { captureWorkspaceShadow, getWorkspaceShadowRepoDir } from './workspace-shadow-git'

export interface ShadowReconcileSummary {
  /** 有底座、本次尝试对账的工作区数。 */
  attempted: number
  /** 采集成功的工作区数（tree 没变也算成功）。 */
  captured: number
  failed: number
  elapsedMs: number
}

/** 启动对账的延迟：先让窗口、首屏和技能迁移跑完，别在用户点开应用时抢磁盘。 */
export const SHADOW_RECONCILE_DELAY_MS = 8_000

let running = false

/**
 * 串行对账所有已有底座的工作区。
 *
 * 同一时刻只允许一个实例在跑：启动流程与手动触发的路径可能重叠，重复采集没有意义。
 */
export async function reconcileWorkspaceShadowOnStartup(): Promise<ShadowReconcileSummary | null> {
  if (running) return null
  running = true
  const startedAt = Date.now()
  let attempted = 0
  let captured = 0
  let failed = 0
  try {
    const workspaces = listAgentWorkspaces().filter((workspace) => {
      if (workspace.isDeleted || workspace.archived) return false
      try {
        return existsSync(getWorkspaceShadowRepoDir(workspace.id))
      } catch {
        // 工作区 id 不能作为目录名：跳过而不是让整轮对账中断。
        return false
      }
    })

    for (const workspace of workspaces) {
      attempted += 1
      try {
        const result = await captureWorkspaceShadow({ workspace, reason: 'startup-reconcile' })
        if (result?.ok) captured += 1
        else failed += 1
      } catch (error) {
        failed += 1
        console.warn(`[Shadow Git] 启动对账失败（${workspace.slug}）:`, error)
      }
    }

    const summary: ShadowReconcileSummary = {
      attempted,
      captured,
      failed,
      elapsedMs: Date.now() - startedAt,
    }
    if (attempted > 0) {
      console.log(
        `[Shadow Git] 启动对账完成: ${captured}/${attempted} 成功，${failed} 失败，${summary.elapsedMs}ms`,
      )
    }
    return summary
  } finally {
    running = false
  }
}
