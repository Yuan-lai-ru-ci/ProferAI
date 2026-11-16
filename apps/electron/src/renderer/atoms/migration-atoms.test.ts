import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import {
  cancelMigrationExportAtom,
  migrationExportStateAtom,
} from './migration-atoms'
import {
  applyMigrationExportProgress,
  isMigrationExportActive,
  type MigrationExportState,
} from '../lib/migration-export'

const runningState = (taskId = 'task-a'): MigrationExportState => ({
  status: 'running',
  taskId,
  progress: null,
  result: null,
})

async function withCancelApi(
  impl: (taskId: string) => Promise<boolean>,
  run: (calls: string[]) => Promise<void>,
): Promise<void> {
  const calls: string[] = []
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        migrationCancelExport: (taskId: string) => {
          calls.push(taskId)
          return impl(taskId)
        },
      },
    },
  })
  try {
    await run(calls)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

describe('导出任务全局状态', () => {
  test('Given 导出运行中 When 主进程受理取消 Then 进入取消中且仍接收进度', async () => {
    const store = createStore()
    store.set(migrationExportStateAtom, runningState('task-a'))

    await withCancelApi(async () => true, async (calls) => {
      await store.set(cancelMigrationExportAtom)
      expect(calls).toEqual(['task-a'])
      expect(store.get(migrationExportStateAtom).status).toBe('cancelling')
      const next = applyMigrationExportProgress(store.get(migrationExportStateAtom), {
        taskId: 'task-a', phase: 'packing', percent: 40, bytesWritten: 4, totalBytes: 10,
      })
      expect(next.progress?.percent).toBe(40)
    })
  })

  test('Given 主进程未受理取消 When 写 atom Then 恢复运行态以便再次尝试', async () => {
    const store = createStore()
    store.set(migrationExportStateAtom, runningState())

    await withCancelApi(async () => false, async () => {
      await store.set(cancelMigrationExportAtom)
    })

    expect(store.get(migrationExportStateAtom).status).toBe('running')
  })

  test('Given 取消请求失败 When 写 atom Then 保持运行态而不是卡在取消中', async () => {
    const store = createStore()
    store.set(migrationExportStateAtom, runningState())
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { electronAPI: { migrationCancelExport: async () => { throw new Error('fixture') } } },
    })
    const originalError = console.error
    console.error = () => {}
    try {
      await store.set(cancelMigrationExportAtom)
    } finally {
      console.error = originalError
      if (previous) Object.defineProperty(globalThis, 'window', previous)
      else Reflect.deleteProperty(globalThis, 'window')
    }

    expect(store.get(migrationExportStateAtom).status).toBe('running')
  })

  test('Given 任务已结束 When 取消 Then 不发起取消请求也不改变状态', async () => {
    const store = createStore()
    const finished: MigrationExportState = {
      status: 'finished', taskId: null, progress: null, result: { success: true },
    }
    store.set(migrationExportStateAtom, finished)

    await withCancelApi(async () => true, async (calls) => {
      await store.set(cancelMigrationExportAtom)
      expect(calls).toEqual([])
    })

    expect(store.get(migrationExportStateAtom)).toBe(finished)
  })

  test('Given 过期任务或已结束任务 When 推送进度 Then 状态引用不变', () => {
    const running = runningState('task-a')
    const stale = applyMigrationExportProgress(running, {
      taskId: 'task-b', phase: 'packing', percent: 1, bytesWritten: 1, totalBytes: 2,
    })
    expect(stale).toBe(running)

    const finished: MigrationExportState = {
      status: 'finished', taskId: null, progress: null, result: { success: true },
    }
    const late = applyMigrationExportProgress(finished, {
      taskId: 'task-a', phase: 'packing', percent: 1, bytesWritten: 1, totalBytes: 2,
    })
    expect(late).toBe(finished)
    expect(isMigrationExportActive(finished)).toBe(false)
  })
})
