/**
 * 「最后已知上下文窗口」持久化的行为测试。
 *
 * 回归点：过去窗口只存在运行时快照里，run_idle 一清，网页端跑完一轮刷新就
 * 永远显示「未知名」。这里验证窗口能跨「清空」按会话留住。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configDir = mkdtempSync(join(tmpdir(), 'profer-ctxwin-'))
process.env.PROFER_CONFIG_DIR = configDir

const {
  persistContextWindow,
  readPersistedContextWindow,
  listPersistedContextWindows,
  deletePersistedContextWindow,
} = await import('./agent-context-window-persistence')

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true })
})

describe('上下文窗口持久化', () => {
  test('Given 一次上报 When 写入 Then 能按会话读回', () => {
    expect(readPersistedContextWindow('session-a')).toBeNull()
    persistContextWindow('session-a', 200_000)
    expect(readPersistedContextWindow('session-a')).toBe(200_000)
    expect(existsSync(join(configDir, 'agent-context-windows.json'))).toBe(true)
  })

  test('Given 同会话再次上报不同值 When 写入 Then 只保留最后一次', () => {
    persistContextWindow('session-a', 1_050_000)
    expect(readPersistedContextWindow('session-a')).toBe(1_050_000)
    expect(listPersistedContextWindows()).toHaveLength(1)
  })

  test('Given 多个会话 When 按集合列出 Then 只返回指定会话', () => {
    persistContextWindow('session-b', 128_000)
    expect(listPersistedContextWindows(['session-b']).map((item) => item.sessionId)).toEqual(['session-b'])
    expect(listPersistedContextWindows(['missing'])).toEqual([])
  })

  test('Given 会话删除 When 清理 Then 不残留', () => {
    deletePersistedContextWindow('session-a')
    expect(readPersistedContextWindow('session-a')).toBeNull()
    expect(readPersistedContextWindow('session-b')).toBe(128_000)
  })

  test('Given 无效窗口值 When 写入 Then 忽略而不是污染记录', () => {
    persistContextWindow('session-b', 0)
    persistContextWindow('session-b', Number.NaN)
    persistContextWindow('', 200_000)
    expect(readPersistedContextWindow('session-b')).toBe(128_000)
  })
})
