import { describe, expect, test } from 'bun:test'
import { resolveRunInitiator, type AgentExternalRunSource, type AgentRunInitiator } from '@profer/shared'
import {
  buildArchiveToggleUpdates,
  shouldClearSessionUnreadOnRunStart,
  shouldMarkSessionUnreadOnCompletion,
} from './agent-unread-policy'

/**
 * 「会话未读」宿主策略的双模式真值表（`design.md` §10 单测第 1、2 组）。
 *
 * 第 1 组（关闭态保真）：把现在 `main` 的行为逐点钉死——模式入参化之后，关闭态分支必须与
 * 既有实现完全一致，否则「不开开关的人不该有任何行为变化」这条硬约束就破了。
 *
 * 第 2 组（开启态策略）：`requirements.md` §3.2 的口径。
 */

const ALL_INITIATORS: AgentRunInitiator[] = ['user', 'automation', 'external', 'goal', 'delegation']

describe('关闭态（auto）保真：run 启动清未读＝现状', () => {
  test('Given 任意发起者 When 关闭态 run 启动 Then 一律清未读（等价于原 runAgent 开头的无条件写 false）', () => {
    for (const initiator of ALL_INITIATORS) {
      expect(shouldClearSessionUnreadOnRunStart(initiator, 'auto')).toBe(true)
    }
  })
})

describe('关闭态（auto）保真：主进程不产生未读', () => {
  test('Given 任何完成输入 When 关闭态 Then 恒不写未读（完成类未读由渲染层 presence 判定产生）', () => {
    const cases = [
      { initiator: 'user' as const },
      { initiator: 'automation' as const, backgroundTasksPending: false, delegationDepth: 0, started: true },
      { initiator: 'external' as const, started: true },
      { initiator: 'goal' as const, started: true },
      { initiator: 'delegation' as const, delegationDepth: 3 },
      { initiator: 'user' as const, started: false },
      { initiator: 'user' as const, backgroundTasksPending: true },
    ]
    for (const input of cases) {
      expect(shouldMarkSessionUnreadOnCompletion(input, 'auto')).toBe(false)
    }
  })
})

describe('关闭态（auto）保真：归档不碰未读', () => {
  test('Given 未读会话 When 关闭态归档 Then 只切 archived（含取消置顶），不写 completedButUnconfirmed', () => {
    const updates = buildArchiveToggleUpdates({ archived: false, pinned: true, completedButUnconfirmed: true }, 'auto')
    expect(updates).toEqual({ archived: true, pinned: false })
    expect('completedButUnconfirmed' in updates).toBe(false)
  })

  test('Given 未读且未置顶的会话 When 关闭态归档 Then 只有 archived', () => {
    expect(buildArchiveToggleUpdates({ archived: false, pinned: false, completedButUnconfirmed: true }, 'auto'))
      .toEqual({ archived: true })
  })
})

describe('开启态（manual）：run 启动只有用户自己清未读', () => {
  test('Given 用户自己发新一轮 When 开启态 run 启动 Then 清未读', () => {
    expect(shouldClearSessionUnreadOnRunStart('user', 'manual')).toBe(true)
  })

  test('Given 非用户发起（队列续跑 / 定时 / 外部 IM / Goal / 委派）When run 启动 Then 不清既有未读', () => {
    for (const initiator of ['automation', 'external', 'goal', 'delegation'] as AgentRunInitiator[]) {
      expect(shouldClearSessionUnreadOnRunStart(initiator, 'manual')).toBe(false)
    }
  })
})

describe('开启态（manual）：终态写未读', () => {
  test('Given 一轮正常完成 When 开启态 Then 写未读（含用户正在查看该会话的情形）', () => {
    expect(shouldMarkSessionUnreadOnCompletion({ initiator: 'user', started: true, delegationDepth: 0 }, 'manual'))
      .toBe(true)
  })

  test('Given 失败 / 用户中断结束 When 开启态 Then 仍写未读（失败不自动已读）', () => {
    // 「失败 / 中断」在调用点表现为终态分支，输入形状与正常完成一致（没有 started:false）。
    expect(shouldMarkSessionUnreadOnCompletion({ initiator: 'user', started: true }, 'manual')).toBe(true)
  })

  test('Given 非用户发起的运行完成 When 开启态 Then 照常写未读（不清既有未读是启动侧的事）', () => {
    for (const initiator of ['automation', 'external', 'goal', 'delegation'] as AgentRunInitiator[]) {
      expect(shouldMarkSessionUnreadOnCompletion({ initiator, started: true, delegationDepth: 0 }, 'manual')).toBe(true)
    }
  })

  test('Given 后台任务续轮 When 开启态 Then 不写未读（不算一轮完成）', () => {
    expect(shouldMarkSessionUnreadOnCompletion({ initiator: 'user', started: true, backgroundTasksPending: true }, 'manual'))
      .toBe(false)
  })

  test('Given 委派子会话（delegationDepth > 0）When 完成 Then 不写未读', () => {
    expect(shouldMarkSessionUnreadOnCompletion({ initiator: 'delegation', started: true, delegationDepth: 1 }, 'manual'))
      .toBe(false)
    // 父会话自动续跑同样以 headless source 'delegation' 启动，但 delegationDepth 为 0 ⇒ 产生未读。
    expect(shouldMarkSessionUnreadOnCompletion({ initiator: 'delegation', started: true, delegationDepth: 0 }, 'manual'))
      .toBe(true)
  })

  test('Given 请求从未启动（started === false）When 结束 Then 不写未读', () => {
    expect(shouldMarkSessionUnreadOnCompletion({ initiator: 'user', started: false }, 'manual')).toBe(false)
  })
})

describe('开启态（manual）：归档视作已读', () => {
  test('Given 未读会话 When 开启态归档 Then 追加 completedButUnconfirmed = false', () => {
    expect(buildArchiveToggleUpdates({ archived: false, pinned: true, completedButUnconfirmed: true }, 'manual'))
      .toEqual({ archived: true, pinned: false, completedButUnconfirmed: false })
  })

  test('Given 已读会话 When 开启态归档 Then 不额外写未读字段', () => {
    expect(buildArchiveToggleUpdates({ archived: false, pinned: false, completedButUnconfirmed: false }, 'manual'))
      .toEqual({ archived: true })
  })

  test('Given 未读的已归档会话 When 解归档 Then 不反向置未读、也不清未读', () => {
    for (const mode of ['auto', 'manual'] as const) {
      const updates = buildArchiveToggleUpdates({ archived: true, pinned: false, completedButUnconfirmed: true }, mode)
      expect(updates).toEqual({ archived: false })
    }
  })
})

describe('resolveRunInitiator 真值表', () => {
  test('Given 走了 headless When 解析发起者 Then source 优先于 triggeredBy', () => {
    // 飞书 / 钉钉 / 微信 / bridge 即使 triggeredBy 缺省或写成 user，都必须是 external。
    for (const source of ['feishu', 'dingtalk', 'wechat', 'bridge'] as AgentExternalRunSource[]) {
      expect(resolveRunInitiator(undefined, source)).toBe('external')
      expect(resolveRunInitiator('user', source)).toBe('external')
    }
    expect(resolveRunInitiator('user', 'delegation')).toBe('delegation')
    expect(resolveRunInitiator('user', 'automation')).toBe('automation')
  })

  test('Given 无 headless source When 解析发起者 Then 按 triggeredBy 映射（缺省＝用户）', () => {
    expect(resolveRunInitiator('user')).toBe('user')
    expect(resolveRunInitiator(undefined)).toBe('user')
    expect(resolveRunInitiator('automation')).toBe('automation')
    expect(resolveRunInitiator('delegation')).toBe('delegation')
    expect(resolveRunInitiator('goal')).toBe('goal')
  })

  test('Given headless 但没有显式 source When 兜底 Then 必须落到 external（宁可留角标，不可静默吃掉）', () => {
    // 固化 `runAgentHeadless` 的兜底表达式，防止后续被改回 `?? 'bridge'` 之外的东西或退化成 'user'。
    const headlessFallback = (source: AgentExternalRunSource | undefined): AgentRunInitiator =>
      source ? resolveRunInitiator(undefined, source) : 'external'
    expect(headlessFallback(undefined)).toBe('external')
    expect(headlessFallback('automation')).toBe('automation')
    expect(headlessFallback('delegation')).toBe('delegation')
    expect(headlessFallback('bridge')).toBe('external')
    expect(headlessFallback('feishu')).toBe('external')
  })
})
