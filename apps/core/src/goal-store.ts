import { existsSync, mkdirSync, linkSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadGoalStates, saveGoalStates, archiveGoalState, loadGoalHistory } from '@profer/agent-runtime/goal-store'
import { normalizeGoalToolResult } from '@profer/agent-runtime/goal-result'
import type { AgentGoalState, AgentGoalIterationResult } from '@profer/shared'

/** Core私有路径适配；Goal schema/迁移/历史验证复用既有store。 */
export class CoreGoalStore {
  constructor(private readonly path: string) {}
  load(): AgentGoalState[] {
    const states = loadGoalStates(this.path)
    if (existsSync(this.path)) saveGoalStates(this.path, states)
    return states
  }
  save(states: AgentGoalState[]): void { saveGoalStates(this.path, states) }
  archive(state: AgentGoalState): void { archiveGoalState(this.path, state) }
  history(sessionId?: string): AgentGoalState[] { return loadGoalHistory(this.path, sessionId) }
  report(goalId: string, runId: string, input: AgentGoalIterationResult): AgentGoalIterationResult {
    const result = normalizeGoalToolResult(input)
    if (result.outcome === 'failed') throw new Error(result.error)
    if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Goal Run身份无效')
    const reportPath = join(dirname(this.path), 'goal-reports', `${runId}.json`)
    if (existsSync(reportPath)) throw new Error('此Goal Run已经提交结构化报告')
    mkdirSync(dirname(reportPath), { recursive: true })
    const temp = `${reportPath}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, JSON.stringify({ goalId, runId, result }), { mode: 0o600, flag: 'wx' })
      // 原子仅创建最终文件；重复run跨提交者也不能覆盖已接受报告。
      linkSync(temp, reportPath)
    } finally {
      if (existsSync(temp)) unlinkSync(temp)
    }
    return structuredClone(result)
  }
}
