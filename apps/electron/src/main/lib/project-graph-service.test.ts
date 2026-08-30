import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

describe('Graph sessionId 安全边界', () => {
  test('拒绝路径穿越和不安全字符', async () => {
    useTempConfig()
    const service = await import(`./project-graph-service?test=${Date.now()}-${Math.random()}`)
    for (const sessionId of ['../secret', 'nested/session', 'session id', '..']) {
      expect(() => service.loadGraph(sessionId)).toThrow('无效的会话标识')
      expect(() => service.appendGraphEvent(sessionId, {
        type: 'task_created', taskId: 'task', timestamp: 1,
        payload: { subject: 'task', description: '', dependsOn: [] },
      })).toThrow('无效的会话标识')
    }
  })

  test('拒绝指向会话目录外的 Graph 符号链接', async () => {
    const root = useTempConfig()
    const service = await import(`./project-graph-service?test=${Date.now()}-${Math.random()}`)
    const sessionsDir = join(root, 'agent-sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const outside = join(root, 'outside.jsonl')
    writeFileSync(outside, '', 'utf8')
    try {
      symlinkSync(outside, join(sessionsDir, 'session-escape-graph.jsonl'), 'file')
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }

    expect(() => service.loadGraph('session-escape')).toThrow('符号链接')
    expect(() => service.appendGraphEvent('session-escape', {
      type: 'task_created', taskId: 'task', timestamp: 1,
      payload: { subject: 'task', description: '', dependsOn: [] },
    })).toThrow('符号链接')
  })
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
