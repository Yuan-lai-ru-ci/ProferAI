import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { AgentGoalState } from '@profer/shared'
import { getGoalActions, goalHistoryAtomFamily, mergeAgentGoalAtom } from '../../atoms/goal-atoms'
import { allPendingAskUserRequestsAtom, allPendingPermissionRequestsAtom } from '../../atoms/agent-atoms'
import { GoalStatusBar, GoalHistoryDetails, GoalLifecycleDetails } from './GoalStatusBar'

const goal = (status: AgentGoalState['status']): AgentGoalState => ({
  id: 'g', sessionId: 's', goal: '交付目标', status, revision: 1, iteration: 2,
  consecutiveFailures: 0, startedAt: 100, updatedAt: 200, elapsedMs: 4000,
  limits: { maxIterations: 20, maxDurationMs: 7200000, maxConsecutiveFailures: 3 },
})
function render(state: AgentGoalState) {
  const store = createStore()
  store.set(mergeAgentGoalAtom, { sessionId: 's', state })
  return renderToStaticMarkup(<Provider store={store}><GoalStatusBar sessionId="s" /></Provider>)
}

describe('Goal 状态栏渲染', () => {
  test('blocked/failed/stopped 都提供恢复入口', () => {
    for (const status of ['blocked', 'failed', 'stopped'] as const) {
      expect(render(goal(status))).toContain('恢复 Goal')
    }
  })

  test('预算耗尽显示原因和预算编辑，而非盲目恢复按钮', () => {
    const html = render({ ...goal('budget_limited'), iteration: 20, stopReason: 'max_iterations' })
    expect(html).toContain('预算已耗尽')
    expect(html).toContain('已达到轮次上限')
    expect(html).toContain('修改预算后恢复')
    expect(html).not.toContain('title="恢复 Goal"')
  })

  test('每个状态的按钮跟随 shared 能力，含 owner 未释放的终态', () => {
    for (const status of ['active', 'stopping', 'paused', 'blocked', 'failed', 'completed', 'stopped', 'budget_limited'] as const) {
      for (const activeRunId of [undefined, 'unsettled']) {
        const state = { ...goal(status), activeRunId }
        const html = render(state)
        const actions = getGoalActions(state)
        const buttons = {
          canPause: '暂停 Goal', canStop: '停止 Goal', canResume: '恢复 Goal',
          canEdit: '编辑目标、契约与预算', canClear: '清除 Goal 状态',
        } as const
        for (const [capability, title] of Object.entries(buttons)) {
          expect(html.includes(`title="${title}"`)).toBe(actions[capability as keyof typeof buttons])
        }
      }
    }
  })

  test('预算编辑够用后 budget_limited 展示恢复按钮，owner 未释放则仍禁止', () => {
    const updated = { ...goal('budget_limited'), iteration: 20, limits: { ...goal('budget_limited').limits, maxIterations: 21 } }
    const html = render(updated)
    expect(html).toContain('title="恢复 Goal"')
    expect(html).not.toContain('修改预算后恢复')
    expect(render({ ...updated, activeRunId: 'unsettled' })).not.toContain('title="恢复 Goal"')
  })

  test('结构化重启原因与旧 stopReason 都提示显式恢复', () => {
    expect(render({ ...goal('paused'), reasonCode: 'app_restart', reasonDetail: '应用退出后需要显式恢复' })).toContain('重启后待恢复')
    expect(render({ ...goal('paused'), stopReason: 'app_restart' })).toContain('重启后待恢复')
    expect(render({ ...goal('paused'), stopReason: 'process_exit' })).toContain('重启后待恢复')
    expect(render({ ...goal('paused'), reasonCode: 'user_pause', stopReason: 'app_restart' })).not.toContain('重启后待恢复')
  })

  test('cleared 快照不再显示 live 按钮，但状态栏保留归档入口', () => {
    const store = createStore()
    store.set(mergeAgentGoalAtom, { sessionId: 's', state: goal('paused') })
    const cleared: AgentGoalState = {
      ...goal('stopped'), revision: 2, reasonCode: 'cleared',
      lifecycle: [{ id: 'clear', goalId: 'g', sessionId: 's', from: 'paused', to: 'cleared', reason: 'cleared', revision: 2, at: 300 }],
    }
    store.set(mergeAgentGoalAtom, { sessionId: 's', state: cleared })
    const html = renderToStaticMarkup(<Provider store={store}><GoalStatusBar sessionId="s" /></Provider>)
    expect(html).toContain('已归档 Goal（1）')
    expect(html).not.toContain('title="恢复 Goal"')
    expect(html).not.toContain('title="清除 Goal 状态"')
    expect(store.get(goalHistoryAtomFamily('s'))).toEqual([cleared])
  })

  test('stopping 不能再次停止或编辑，不伪装已经结束', () => {
    const html = render(goal('stopping'))
    expect(html).toContain('正在停止')
    expect(html).not.toContain('title="停止 Goal"')
    expect(html).not.toContain('title="编辑目标、契约与预算"')
  })

  test('耗时采用累计净执行时间，明确同会话接续', () => {
    const html = render(goal('paused'))
    expect(html).toContain('4s')
    expect(html).toContain('沿用当前会话上下文')
  })

  test('等待空闲与交互请求不伪装成正在执行', () => {
    expect(render(goal('active'))).toContain('等待会话空闲')
    const store = createStore()
    store.set(mergeAgentGoalAtom, { sessionId: 's', state: { ...goal('active'), activeRunId: 'run' } })
    store.set(allPendingAskUserRequestsAtom, new Map([['s', [{ requestId: 'ask', sessionId: 's', questions: [], toolInput: {} }]]]))
    expect(renderToStaticMarkup(<Provider store={store}><GoalStatusBar sessionId="s" /></Provider>)).toContain('等待你的回答')
    store.set(allPendingAskUserRequestsAtom, new Map())
    store.set(allPendingPermissionRequestsAtom, new Map([['s', [{ requestId: 'permission', sessionId: 's', toolName: 'Bash', toolInput: {}, description: '运行命令', dangerLevel: 'normal' }]]]))
    expect(renderToStaticMarkup(<Provider store={store}><GoalStatusBar sessionId="s" /></Provider>)).toContain('等待审批')
  })

  test('非 active 不因残留交互请求变成持久等待态', () => {
    const store = createStore()
    const state = goal('paused')
    store.set(mergeAgentGoalAtom, { sessionId: 's', state })
    store.set(allPendingAskUserRequestsAtom, new Map([['s', [{ requestId: 'ask', sessionId: 's', questions: [], toolInput: {} }]]]))
    store.set(allPendingPermissionRequestsAtom, new Map([['s', [{ requestId: 'permission', sessionId: 's', toolName: 'Bash', toolInput: {}, description: '运行命令', dangerLevel: 'normal' }]]]))
    const html = renderToStaticMarkup(<Provider store={store}><GoalStatusBar sessionId="s" /></Provider>)
    expect(html).toContain('已暂停')
    expect(html).not.toContain('等待你的回答')
    expect(html).not.toContain('等待审批')
    expect(state.status).toBe('paused')
  })

  test('轮次历史显示失败与证据，归档目标可展开', () => {
    const archived = {
      ...goal('failed'),
      history: [{ iteration: 1, startedAt: 100, finishedAt: 200, status: 'continue' as const, summary: '运行失败', evidence: ['test.log'], outcome: 'failed' as const, error: '连接中断' }],
    }
    const html = renderToStaticMarkup(<GoalHistoryDetails goals={[archived]} />)
    expect(html).toContain('<details')
    expect(html).toContain('交付目标')
    expect(html).toContain('运行失败')
    expect(html).toContain('test.log')
    expect(html).toContain('连接中断')
  })
})

describe('Goal 原因与生命周期详情', () => {
  test('结构化原因优先、旧自由文本保留，特殊字符按文本转义', () => {
    const html = renderToStaticMarkup(<GoalHistoryDetails goals={[{
      ...goal('blocked'), reasonCode: 'blocked', reasonDetail: '缺少 <凭据> & 需要授权', stopReason: '旧原因不应覆盖',
    }]} />)
    expect(html).toContain('等待处理：缺少 &lt;凭据&gt; &amp; 需要授权')
    expect(html).not.toContain('旧原因不应覆盖')
    const legacy = renderToStaticMarkup(<GoalHistoryDetails goals={[{ ...goal('failed'), stopReason: '连接中断，请稍后恢复' }]} />)
    expect(legacy).toContain('连接中断，请稍后恢复')
    const codeOnly = renderToStaticMarkup(<GoalHistoryDetails goals={[{ ...goal('paused'), reasonCode: 'app_restart' }]} />)
    expect(codeOnly).toContain('应用退出或重启后暂停')
    const detailOnly = renderToStaticMarkup(<GoalHistoryDetails goals={[{ ...goal('failed'), reasonDetail: '保留迁移后的原因详情' }]} />)
    expect(detailOnly).toContain('保留迁移后的原因详情')
  })

  test('旧数据没有 lifecycle 时不展示空状态转移区域', () => {
    expect(renderToStaticMarkup(<GoalLifecycleDetails goal={goal('paused')} />)).toBe('')
    expect(renderToStaticMarkup(<GoalLifecycleDetails goal={{ ...goal('paused'), lifecycle: [] }} />)).toBe('')
    expect(renderToStaticMarkup(<GoalHistoryDetails goals={[goal('paused')]} />)).not.toContain('最近状态转移')
  })

  test('中文显示转移前后状态、原因、时间、版本与 runId，默认可展开', () => {
    const state: AgentGoalState = {
      ...goal('stopped'),
      lifecycle: [
        { id: 'created', goalId: 'g', sessionId: 's', from: null, to: 'active', reason: 'created', revision: 1, at: 100 },
        { id: 'blocked', goalId: 'g', sessionId: 's', from: 'active', to: 'blocked', reason: 'blocked', detail: '需要访问凭据', revision: 2, at: 200, runId: 'run-a' },
        { id: 'cleared', goalId: 'g', sessionId: 's', from: 'blocked', to: 'cleared', reason: 'cleared', revision: 3, at: 300 },
      ],
    }
    const html = renderToStaticMarkup(<GoalLifecycleDetails goal={state} />)
    expect(html).toContain('<details')
    expect(html).not.toContain(' open=""')
    expect(html).toContain('最近状态转移（3）')
    expect(html).toContain('尚未创建 → 执行中')
    expect(html).toContain('执行中 → 等待处理')
    expect(html).toContain('等待处理 → 已清除并归档')
    expect(html).toContain('等待处理：需要访问凭据')
    expect(html).toContain('版本 2')
    expect(html).toContain('运行 run-a')
    expect(html).toContain('dateTime="1970-01-01T00:00:00.200Z"')
    expect(html.indexOf('已清除并归档')).toBeLessThan(html.indexOf('需要访问凭据'))
    expect(html.indexOf('需要访问凭据')).toBeLessThan(html.indexOf('创建目标'))
    expect(renderToStaticMarkup(<GoalHistoryDetails goals={[state]} />)).toContain('最近状态转移（3）')
  })

  test('只展示最近十次转移，倒序展示但不改写原历史', () => {
    const lifecycle: NonNullable<AgentGoalState['lifecycle']> = Array.from({ length: 12 }, (_, index) => ({
      id: `event-${index}`, goalId: 'g', sessionId: 's', from: 'active', to: 'paused', reason: 'user_pause',
      detail: `转移记录[${index}]`, revision: index + 1, at: 100 + index,
    }))
    const original = [...lifecycle]
    const html = renderToStaticMarkup(<GoalLifecycleDetails goal={{ ...goal('paused'), lifecycle }} />)
    expect(html).toContain('最近状态转移（10）')
    expect(html).not.toContain('转移记录[0]')
    expect(html).not.toContain('转移记录[1]')
    expect(html).toContain('转移记录[2]')
    expect(html.indexOf('转移记录[11]')).toBeLessThan(html.indexOf('转移记录[10]'))
    expect(lifecycle).toEqual(original)
  })
})


test('异常历史时间降级展示，不使状态栏详情崩溃', () => {
  const state = { ...goal('paused'), lifecycle: [{ id: 'invalid-time', goalId: 'g', sessionId: 's', from: 'active' as const, to: 'paused' as const, reason: 'user_pause' as const, revision: 2, at: Number.MAX_SAFE_INTEGER }] }
  expect(renderToStaticMarkup(<GoalHistoryDetails goals={[state]} />)).toContain('历史时间无效')
})
