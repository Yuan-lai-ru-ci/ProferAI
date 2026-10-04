import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentGoalState } from '@profer/shared'
import { GoalController } from './goal-controller'
import { archiveGoalState, loadGoalHistory, loadGoalStates, saveGoalStates } from './goal-store'

/** 用真实文件验证 Controller 生成的审计轨迹可落盘、重启并清除。 */
describe('Goal v2 Controller / Store 集成', () => {
  test('blocked -> resume -> complete -> clear 在 schema 3 往返且不复活', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-v2-'))
    try {
      const path = join(dir, 'goals.json')
      let complete = false
      let controller!: GoalController
      const scheduled: Array<() => void> = []
      const errors: unknown[] = []
      const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
      const make = () => new GoalController({
        runTurn: async () => complete ? { status: 'complete', summary: '验收通过', evidence: ['测试通过'] } : { status: 'blocked', summary: '需要凭据', evidence: [] },
        stopTurn: async () => {},
        schedule: (callback) => { scheduled.push(callback); return callback }, cancelSchedule: () => {},
        setTimer: () => 1, clearTimer: () => {},
        onBeforeClear: (state) => archiveGoalState(path, state),
        onStateChange: () => { try { saveGoalStates(path, controller.list()) } catch (error) { errors.push(error) } },
      })
      controller = make()
      await controller.start('session', '目标')
      scheduled.shift()?.()
      await flush()
      expect(errors).toEqual([])
      expect(loadGoalStates(path)[0]).toMatchObject({ status: 'blocked', reasonCode: 'blocked', reasonDetail: '需要凭据' })
      controller = make()
      controller.restore(loadGoalStates(path))
      complete = true
      await controller.resume('session')
      scheduled.shift()?.()
      await flush()
      expect(errors).toEqual([])
      const saved = loadGoalStates(path)[0]!
      expect(saved.status).toBe('completed')
      expect(saved.lifecycle?.map((event) => event.to)).toEqual(['active', 'blocked', 'active', 'completed'])
      controller.clear('session')
      expect(loadGoalStates(path)).toEqual([])
      const archived: AgentGoalState = loadGoalHistory(path)[0]!
      expect(archived.lifecycle?.at(-1)).toMatchObject({ from: 'completed', to: 'cleared' })
      expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(3)
      controller = make()
      controller.restore(loadGoalStates(path))
      expect(controller.list()).toEqual([])
      expect(errors).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
