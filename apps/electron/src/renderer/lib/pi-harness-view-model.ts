import type { PiHarnessSnapshotView, PiHarnessTaskView } from '@profer/shared'

export interface PiHarnessTaskPresentation {
  badge?: { label: string; tone: 'emerald' | 'amber' | 'red' | 'muted' | 'blue' }
  executionLabel?: string
  assuranceLabel?: string
  pauseReason?: string
  lastFactSummary?: string
  shadowCandidateLabel?: string
  /** UI hint from the sanitized main-process projection; never a scheduling command. */
  canManuallyContinue?: boolean
}

function executionLabel(state: NonNullable<PiHarnessTaskView['execution']>['state']): string {
  switch (state) {
    case 'starting': return '准备执行'
    case 'running': return '正在执行'
    case 'compacting': return '正在压缩上下文'
    case 'retrying': return '正在重试'
    case 'settled': return '本轮已结束'
    case 'interrupted': return '已暂停'
    case 'failed': return '本轮失败'
  }
}

/** Maps a sanitized Harness view to small, read-only graph UI signals. */
export function presentPiHarnessTask(
  taskId: string,
  snapshot: PiHarnessSnapshotView | null | undefined,
): PiHarnessTaskPresentation {
  const task = snapshot?.tasks[taskId]
  if (!task) return {}
  const assurance = task.assurance
  const base: PiHarnessTaskPresentation = {
    ...(task.execution ? { executionLabel: executionLabel(task.execution.state) } : {}),
    ...(assurance ? { assuranceLabel: assurance.reason } : {}),
    ...(task.lastFactSummary ? { lastFactSummary: task.lastFactSummary } : {}),
    ...(task.shadowCandidate ? {
      shadowCandidateLabel: task.shadowCandidate.action === 'required_verification'
        ? `后续验证候选（shadow，未执行）：${task.shadowCandidate.reason}`
        : `后续任务候选（shadow，未执行）：${task.shadowCandidate.reason}`,
      ...(task.shadowCandidate.canManuallyContinue ? { canManuallyContinue: true } : {}),
    } : {}),
  }

  if (snapshot?.goal?.state === 'paused' && snapshot.goal.activeTaskId === taskId) {
    return { ...base, badge: { label: '已暂停', tone: 'muted' }, pauseReason: snapshot.goal.pauseReason ?? '任务链已暂停' }
  }
  if (assurance?.state === 'verified') return { ...base, badge: { label: '已验证', tone: 'emerald' } }
  if (assurance?.state === 'pending') return { ...base, badge: { label: '待验证', tone: 'amber' } }
  if (assurance?.state === 'failed') return { ...base, badge: { label: '验证失败', tone: 'red' } }
  if (assurance?.state === 'waived') return { ...base, badge: { label: '已接受风险', tone: 'muted' } }
  if (task.execution?.state === 'running' || task.execution?.state === 'compacting' || task.execution?.state === 'retrying') {
    return { ...base, badge: { label: task.execution.state === 'compacting' ? '压缩中' : task.execution.state === 'retrying' ? '重试中' : '执行中', tone: 'blue' } }
  }
  return base
}
