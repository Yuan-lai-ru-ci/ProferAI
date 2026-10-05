import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { AGENT_IPC_CHANNELS } from '@profer/shared'

// 执行当前 IPC 注册片段；模拟 Electron transport，验证主进程真实路由而非重复实现。
const source = readFileSync(new URL('../ipc.ts', import.meta.url), 'utf8')
const start = source.indexOf('  ipcMain.handle(AGENT_IPC_CHANNELS.START_GOAL,')
const end = source.indexOf('  // ===== Agent 队列消息 =====', start)
if (start < 0 || end < start) throw new Error('Goal IPC 注册边界不存在')
const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))
const register = new Function('deps', `const { ipcMain, AGENT_IPC_CHANNELS, assertSensitiveAgentIpcSender, goalSessionService, feishuBridgeManager, stopAgentAndWait, isGoalRunActive } = deps; ${js}`)

function harness(goalOwner = false) {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const calls: string[] = []
  const state = { id: 'g', activeRunId: 'run', status: 'active' }
  register({
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler) },
    AGENT_IPC_CHANNELS,
    assertSensitiveAgentIpcSender: () => { calls.push('guard') },
    goalSessionService: {
      start: async () => { calls.push('start'); return state },
      get: () => state, list: () => [state],
      pause: async () => { calls.push('pause'); return state },
      resume: async () => { calls.push('resume'); return state },
      stop: async () => { calls.push('goal-stop'); return state },
      pauseForInterrupt: async () => { calls.push('goal-interrupt'); return state },
      clear: () => { calls.push('clear') },
      update: () => { calls.push('update'); return state },
      history: () => { calls.push('history'); return [state] },
    },
    feishuBridgeManager: { stopSessionMirrorRun: () => { calls.push('mirror-stop') } },
    stopAgentAndWait: async () => { calls.push('ordinary-stop') },
    isGoalRunActive: () => goalOwner,
  })
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`Missing ${channel}`)
    return handler({}, ...args)
  }
  return { calls, state, invoke }
}

describe('Goal IPC 控制路由', () => {
  test('新增 update/history 与现有控制接口都经过 sender guard', async () => {
    const h = harness()
    await h.invoke(AGENT_IPC_CHANNELS.UPDATE_GOAL, 's', { limits: { maxIterations: 40 } })
    await h.invoke(AGENT_IPC_CHANNELS.GET_GOAL_HISTORY, 's')
    expect(h.calls).toEqual(['guard', 'update', 'guard', 'history'])
  })
  test('普通 Stop 在 Goal owner 时只中断（暂停）明确目标，不在 await 后误停新 owner', async () => {
    const h = harness(true)
    await h.invoke(AGENT_IPC_CHANNELS.STOP_AGENT, 's')
    expect(h.calls).toEqual(['guard', 'mirror-stop', 'goal-interrupt'])
  })
  test('等待中的 Goal 和当前普通运行都接受用户 Stop；Goal 只暂停不终止', async () => {
    const h = harness(false)
    await h.invoke(AGENT_IPC_CHANNELS.STOP_AGENT, 's')
    expect(h.calls).toEqual(['guard', 'mirror-stop', 'ordinary-stop', 'goal-interrupt'])
  })
  test('非法 start/update/history 不调用服务', async () => {
    const h = harness()
    await expect(h.invoke(AGENT_IPC_CHANNELS.START_GOAL, 's', '')).rejects.toThrow()
    await expect(h.invoke(AGENT_IPC_CHANNELS.UPDATE_GOAL, 's', null)).rejects.toThrow()
    await expect(h.invoke(AGENT_IPC_CHANNELS.GET_GOAL_HISTORY, 123)).rejects.toThrow()
    expect(h.calls).toEqual(['guard', 'guard', 'guard'])
  })
})
