import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('electron', () => ({
  app: { isPackaged: false, getPath: () => '' },
}))

const roots: string[] = []
const originalConfigDir = process.env.PROFER_CONFIG_DIR

function useTempConfig(): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-harness-graph-service-'))
  roots.push(root)
  process.env.PROFER_CONFIG_DIR = root
  return root
}

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('loadHarnessGraphSnapshot', () => {
  test('loads one graph snapshot and returns stable ready/focus facts without writing graph events', async () => {
    useTempConfig()
    const service = await import(`./project-graph-service?test=${Date.now()}-${Math.random()}`)
    const sessionId = 'session-1'
    service.appendGraphEvent(sessionId, {
      type: 'task_created', taskId: 'done', timestamp: 1,
      payload: { subject: 'done', description: '', dependsOn: [] },
    })
    service.appendGraphEvent(sessionId, {
      type: 'task_status_changed', taskId: 'done', timestamp: 2,
      payload: { newStatus: 'completed' },
    })
    service.appendGraphEvent(sessionId, {
      type: 'task_created', taskId: 'later', timestamp: 4,
      payload: { subject: 'later', description: '', dependsOn: ['done'] },
    })
    service.appendGraphEvent(sessionId, {
      type: 'task_created', taskId: 'earlier', timestamp: 3,
      payload: { subject: 'earlier', description: '', dependsOn: [] },
    })

    const first = service.loadHarnessGraphSnapshot(sessionId)
    const second = service.loadHarnessGraphSnapshot(sessionId)

    expect(first.readyTaskIds).toEqual(['earlier', 'later'])
    expect(first.focusTaskId).toBe('earlier')
    expect(first.focusReason).toContain('创建时间最早')
    expect(second).toEqual(first)
    expect(Object.keys(first.graph.nodes)).toHaveLength(3)
  })
})
