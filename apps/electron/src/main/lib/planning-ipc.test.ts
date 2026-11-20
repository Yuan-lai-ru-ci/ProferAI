import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PLANNING_IPC_CHANNELS } from '@profer/shared'

const source = readFileSync(resolve(import.meta.dir, 'planning-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('Planning IPC 注册（结构检查）', () => {
  test('覆盖任务、日程、分组、标签和提醒通道', () => {
    for (const key of [
      'OPEN_WINDOW', 'LIST_TODOS', 'CREATE_TODO', 'START_TODO_AGENT', 'UPDATE_TODO', 'DELETE_TODO',
      'LIST_CALENDAR_EVENTS', 'CREATE_CALENDAR_EVENT', 'UPDATE_CALENDAR_EVENT', 'DELETE_CALENDAR_EVENT',
      'LIST_GROUPS', 'CREATE_GROUP', 'UPDATE_GROUP', 'DELETE_GROUP', 'LIST_TAGS', 'CREATE_TAG', 'UPDATE_TAG', 'DELETE_TAG',
      'LIST_ACTIVE_REMINDERS', 'ACKNOWLEDGE_REMINDER', 'SNOOZE_REMINDER',
    ] as const) {
      expect(source).toContain(`PLANNING_IPC_CHANNELS.${key}`)
      expect(PLANNING_IPC_CHANNELS[key]).toBeDefined()
    }
  })
  test('Todo Agent 跨窗口转交和变更广播', () => {
    expect(source).toContain('feishuBridgeManager.ensureSessionMirror(session)')
    expect(source).toContain("searchParams.get('window')")
    expect(source).toContain('TODO_AGENT_SESSION_READY')
    expect(source).toContain('broadcastPlanningChanged')
  })
  test('standalone Planning window uses the selected dev instance origin rather than a hardcoded port', () => {
    const windowSource = readFileSync(resolve(import.meta.dir, 'planning-window.ts'), 'utf8')
    expect(windowSource).toContain('loadURL(`${VITE_DEV_SERVER_URL}?window=planning`)')
    expect(windowSource).toContain('new URL(url).origin === VITE_DEV_SERVER_URL')
    expect(windowSource).not.toContain('http://127.0.0.1:5173')
  })

  test('ipc.ts 只保留注册入口', () => {
    expect(source).toContain('export function registerPlanningIpc(): void')
    expect(ipc).toContain('registerPlanningIpc()')
    expect(ipc).not.toContain('ipcMain.handle(PLANNING_IPC_CHANNELS.OPEN_WINDOW')
  })
})
