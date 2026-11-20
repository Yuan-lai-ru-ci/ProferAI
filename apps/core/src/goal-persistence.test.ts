import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalController } from '@profer/agent-runtime/goal-controller'
import { CoreGoalStore } from './goal-store'

test('Goal状态保存失败拒绝启动且不排定provider', async () => {
  let turns = 0
  const controller = new GoalController({ runTurn: async () => { turns++; return { status: 'complete', summary: 'fixture', evidence: ['fixture'] } }, stopTurn: async () => {},
    onStateChange() { throw new Error('fixture disk write failure') },
  })
  await expect(controller.start('fixture-session', 'fixture')).rejects.toThrow('fixture disk write failure')
  expect(controller.get('fixture-session')?.status).toBe('paused')
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(turns).toBe(0)
})

test('Goal运行中持久化失败封锁后续调度，不产生未处理后台异常', async () => {
  let turns = 0
  let writes = 0
  const errors: unknown[] = []
  const controller = new GoalController({ runTurn: async () => { turns++; return { status: 'continue', summary: 'fixture', evidence: [] } }, stopTurn: async () => {},
    onStateChange() { writes++; if (writes >= 3) throw new Error('fixture finish write failed') },
    onSchedulerError: error => errors.push(error),
  })
  await controller.start('s', 'fixture')
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(controller.get('s')?.status).toBe('paused')
  expect(turns).toBe(1)
  expect(errors).toHaveLength(1)
})

test('Goal报告只创建一次，重复或失效路径不覆盖、不遗留临时文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'profer-goal-report-'))
  try {
    const store = new CoreGoalStore(join(root, 'core-goals.json'))
    const runId = crypto.randomUUID()
    store.report('goal', runId, { status: 'complete', summary: 'first', evidence: ['fixture'] })
    expect(() => store.report('goal', runId, { status: 'blocked', summary: 'second', evidence: [] })).toThrow()
    expect(JSON.parse(readFileSync(join(root, 'goal-reports', `${runId}.json`), 'utf8')).result.summary).toBe('first')
    expect(() => store.report('goal', '../escape', { status: 'continue', summary: 'escape', evidence: [] })).toThrow()
    expect(readdirSync(join(root, 'goal-reports'))).toEqual([`${runId}.json`])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
