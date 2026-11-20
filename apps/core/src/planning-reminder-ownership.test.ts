import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCoreAgentRuntime } from './runtime'

test('desktop组合Core唯一timer领取提醒，重复tick不重复发布', async () => {
  const root = mkdtempSync(join(tmpdir(), 'profer-core-reminder-'))
  const index = join(root, 'agent-workspaces.json')
  writeFileSync(index, JSON.stringify({ version: 4, workspaces: [] }))
  const original = globalThis.setInterval
  const ticks: Array<() => void> = []
  globalThis.setInterval = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === 30_000 && typeof callback === 'function') ticks.push(() => callback(...args))
    return original(callback, delay, ...args)
  }) as typeof setInterval
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true, desktopWorkspaceIndexPath: index })
  globalThis.setInterval = original
  try {
    const due: unknown[] = []
    runtime.subscribe(event => { if (event.type === 'planning' && (event.payload as { type?: string }).type === 'reminders_due') due.push(event.payload) })
    runtime.planning.createTodo({ title: 'fixture', reminders: [{ triggerAt: Date.now() - 1000 }] })
    expect(ticks.length).toBeGreaterThan(0)
    for (const tick of ticks) tick()
    for (const tick of ticks) tick()
    expect(due).toHaveLength(1)
  } finally { globalThis.setInterval = original; await runtime.shutdown(); rmSync(root, { recursive: true, force: true }) }
})
