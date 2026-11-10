import type { AgentStreamState } from '@/atoms/agent-atoms'
import { isActiveRestoreSnapshot, shouldCreateRestoreState } from '@/lib/agent-stream-restore-gate'

/**
 * 一次恢复快照对某个会话的处置结果。
 *
 * - `keep`：保持现有状态不变；
 * - `settle`：本会话已有运行态但主进程确认没有活跃 run，收敛到可继续输入的终态；
 * - `placeholder`：写入 `running` 占位，等回放的终态把它收敛掉。
 */
export type RestoreMergeAction = 'keep' | 'settle' | 'placeholder'

/** 恢复快照里本模块用到的字段（与 `AgentRuntimeRestoreSnapshot` 对齐）。 */
export interface RestoreSnapshotShape {
  active: boolean
  hasTerminalEvent: boolean
}

/**
 * 决定恢复快照该怎么合并进 `agentStreamingStatesAtom`。
 *
 * 关键边界：主进程会为**已结束**的 run 保留 60s completed backlog，并在恢复时同步回放终态。
 * 如果本窗口在此之前已经收到过该轮终态（状态已收敛为 `running: false`），那么：
 *
 * 1. 回放终态会被 `isCurrentAgentStreamCompletion` 当作迟到终态丢弃（它要求 running）；
 * 2. 快照仍带着 `hasTerminalEvent: true`，若照旧写 `running` 占位，就**盖掉已经收敛的状态**；
 * 3. 主进程侧回放完即 `completedStreamEventBacklogs.delete()`，不会再有第二次回放。
 *
 * 结果就是切回刚结束的会话后永久「运行中」（刷新才恢复）。所以：只有「快照声明有活跃 run」
 * 或「本窗口本来没有该会话状态」（刷新场景，终态会被闸门延后到占位之后派发）才允许写占位。
 */
export function decideRestoreMerge(
  current: AgentStreamState | undefined,
  snapshot: string | RestoreSnapshotShape,
): RestoreMergeAction {
  if (!shouldCreateRestoreState(snapshot)) {
    // 主进程已确认没有活跃 run；清掉旧版本遗留的 running/stopping，保留用量快照。
    if (!current || (!current.running && !current.backgroundWaiting && !current.stopping)) return 'keep'
    return 'settle'
  }
  if (current?.running || current?.backgroundWaiting) return 'keep'
  if (isActiveRestoreSnapshot(snapshot)) return 'placeholder'
  // 非活跃 run 的终态回放：本窗口已有状态说明该终态要么已经派发过、要么刚被竞态保护丢弃。
  // 此时补一个 running 占位没有任何事件能再收敛它，只会残留 spinner。
  if (current) return current.stopping ? 'settle' : 'keep'
  return 'placeholder'
}
