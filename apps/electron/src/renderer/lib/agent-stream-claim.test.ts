import { describe, expect, test } from 'bun:test'
import { shouldClaimAgentStream } from './agent-stream-claim'

const base = {
  tabType: 'agent',
  hasRunningState: false,
  alreadyClaimed: false,
  standalone: false,
}

describe('切换 Agent 会话时是否认领本轮流', () => {
  test('Given 主窗口切到没有运行态的 Agent 会话 When 判定 Then 需要认领', () => {
    expect(shouldClaimAgentStream(base)).toBe(true)
  })

  test('Given 独立会话窗口 When 判定 Then 不认领（主进程不允许跨窗口抢）', () => {
    expect(shouldClaimAgentStream({ ...base, standalone: true })).toBe(false)
  })

  test('Given 非 Agent 标签 When 判定 Then 不认领', () => {
    for (const tabType of ['chat', 'preview', 'plugin', 'scratch', null, undefined]) {
      expect(shouldClaimAgentStream({ ...base, tabType })).toBe(false)
    }
  })

  test('Given 本窗口已有运行态 When 判定 Then 不打扰', () => {
    expect(shouldClaimAgentStream({ ...base, hasRunningState: true })).toBe(false)
  })

  test('Given 本次挂载已认领过 When 判定 Then 不重复请求', () => {
    expect(shouldClaimAgentStream({ ...base, alreadyClaimed: true })).toBe(false)
  })
})
