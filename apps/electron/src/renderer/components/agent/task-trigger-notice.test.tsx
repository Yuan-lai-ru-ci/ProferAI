import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { SDKMessage, SDKSystemMessage } from '@profer/shared'
import { groupIntoTurns, getGroupPreview, MessageGroupRenderer, SDKMessageRenderer } from './SDKMessageRenderer'
import { agentSessionsAtom } from '@/atoms/agent-atoms'
import { AgentMessages } from './AgentMessages'
import { buildNavigationEntries } from '@profer/session-core'
import { buildNavigationItems } from './navigation-items'
import { isScheduledTaskInput, projectTaskInputTimeline } from '@/lib/task-input-timeline'
import { mergeMessagesByUuid } from '@/lib/agent-message-merge'
import { getGroupId } from './SDKMessageRenderer'
import { automationsAtom } from '@/atoms/automation-atoms'

const notice: SDKSystemMessage = {
  type: 'system', subtype: 'task_trigger', uuid: 'notice-1', _createdAt: 100,
  message: '可信来源：研发统筹 Agent 派工；仅执行已交接范围。',
  _provenance: { schemaVersion: 1, messageId: 'notice-1', author: { type: 'agent', id: 'dispatch-agent' }, runId: 'run-1', triggerId: 'trigger-1', source: { type: 'session', id: 'source-session' } },
}
const assistant = (text: string): SDKMessage => ({
  type: 'assistant', parent_tool_use_id: null,
  message: { model: 'same-model', content: [{ type: 'text', text }] },
})
const render = (child: React.ReactElement): string => renderToStaticMarkup(React.createElement(Provider, { store: createStore() }, child))

describe('task_trigger 来源卡渲染', () => {
  test('来源单独成组，不合并两侧助手输出，导航 preview 可读', () => {
    const groups = groupIntoTurns([assistant('before'), notice, assistant('after')])
    expect(groups.map((group) => group.type)).toEqual(['assistant-turn', 'system', 'assistant-turn'])
    expect(getGroupPreview(groups[1]!)).toBe(notice.message!)
  })

  test('持久化与实时渲染均显示中性来源卡、真实作者和正文，不伪造来源链接', () => {
    const markupStore = createStore()
    markupStore.set(agentSessionsAtom, [{ id: 'source-session', title: '原讨论', createdAt: 1, updatedAt: 1 }])
    const markup = renderToStaticMarkup(React.createElement(Provider, { store: markupStore }, React.createElement(MessageGroupRenderer, { group: { type: 'system', message: notice }, allMessages: [notice], historicalTaskSubjects: new Map() })))
    const live = render(React.createElement(SDKMessageRenderer, { message: notice, allMessages: [notice] }))
    for (const html of [markup, live]) {
      expect(html).toContain('data-testid="task-trigger-notice"')
      expect(html).not.toContain('>任务来源<')
      expect(html).toContain('Agent 任务交接')
      expect(html).not.toContain('dispatch-agent')
      expect(html).not.toContain(notice.message!)
      expect(html).not.toContain('amber')
      expect(html).not.toContain('role="alert"')
      expect(html).not.toContain('<a ')
    }
    expect(markup).toContain('data-message-id="notice-1"')
    expect(markup).toContain('来自会话「原讨论」')
  })

  test('有可访问来源才显示定位入口，删除来源保留可读事实和不可访问标记', () => {
    const store = createStore()
    store.set(agentSessionsAtom, [{ id: 'source-session', title: '原讨论', createdAt: 1, updatedAt: 1 }])
    const html = renderToStaticMarkup(React.createElement(Provider, { store }, React.createElement(SDKMessageRenderer, { message: notice, allMessages: [notice] })))
    expect(html).toContain('查看来源会话')
    expect(html).toContain('原讨论')
    expect(html).not.toContain('来源会话不可访问')
    const missing = render(React.createElement(SDKMessageRenderer, { message: { ...notice, _provenance: undefined, message: '历史发起者 dispatch-agent，来源 session source-session，trigger trigger-1。' }, allMessages: [] }))
    expect(missing).toContain('此历史来源记录缺少可验证的来源信息。')
    expect(missing).not.toContain('source-session')
    expect(missing).not.toContain('dispatch-agent')
    const scheduled: SDKSystemMessage = { ...notice, _provenance: { ...notice._provenance!, author: { type: 'automation', id: 'schedule' }, source: { type: 'automation', id: 'schedule' } } }
    store.set(automationsAtom, [{ id: 'schedule', name: '汇总', prompt: '总结', scheduleType: 'daily', intervalMinutes: 1440, channelId: 'channel', runHistory: [], active: true, createdAt: 1, updatedAt: 1, nextRunAt: 1, sessionMode: 'daily' }])
    const automation = renderToStaticMarkup(React.createElement(Provider, { store }, React.createElement(SDKMessageRenderer, { message: scheduled, allMessages: [] })))
    expect(automation).toContain('查看定时任务')
  })

  test('旧版 task_trigger 正文含内部ID时以验证后的来源事实重建展示文案', () => {
    const legacyBody: SDKSystemMessage = { ...notice, message: 'Agent dispatch-agent，source-session-very-long-123，run-123，trigger-123' }
    const html = render(React.createElement(SDKMessageRenderer, { message: legacyBody, allMessages: [] }))
    expect(html).toContain('Agent 任务交接')
    expect(html.match(/来源会话不可访问/g)).toHaveLength(1)
    expect(html).not.toContain('dispatch-agent')
    expect(html).not.toContain('source-session-very-long-123')
    expect(html).not.toContain('run-123')
    expect(html).not.toContain('trigger-123')
  })

  test('定时输入与触发提示在实时和历史均只有一张包含正文的卡片，无用户头像或编辑入口', () => {
    const scheduled = { ...notice, _provenance: { ...notice._provenance!, author: { type: 'automation' as const }, source: { type: 'automation' as const, id: 'schedule' } } }
    const input = {
      type: 'user', parent_tool_use_id: null, _createdAt: 1793512920000,
      message: { content: [{ type: 'text', text: '获取当前本地时间，并追加一条测试日志。\n<!--PROFER_SCHEDULED_RUN-->' }] },
      _provenance: { ...scheduled._provenance!, messageId: 'task-input', author: { type: 'user' as const } },
    } as SDKMessage
    const store = createStore()
    store.set(automationsAtom, [{ id: 'schedule', name: '定时任务链路测试', prompt: '原配置已更新，不能代替本次正文', scheduleType: 'daily', intervalMinutes: 1440, channelId: 'channel', runHistory: [], active: true, createdAt: 1, updatedAt: 1, nextRunAt: 1, sessionMode: 'daily' }])
    const renderGroups = (messages: SDKMessage[]): string => renderToStaticMarkup(React.createElement(Provider, { store }, React.createElement(React.Fragment, null, ...groupIntoTurns(projectTaskInputTimeline(messages)).map(group => React.createElement(MessageGroupRenderer, { key: getGroupId(group), group, allMessages: messages, historicalTaskSubjects: new Map(), onEditUserMessage: () => {} })))))
    const during = renderGroups(mergeMessagesByUuid([scheduled, input], [structuredClone(scheduled), structuredClone(input)]))
    const history = renderGroups([scheduled, structuredClone(input)])
    for (const html of [during, history]) {
      expect(html.match(/data-testid="task-trigger-notice"/g)).toHaveLength(1)
      expect(html).toContain('定时任务触发')
      expect(html).toContain('定时任务链路测试')
      expect(html).toContain('获取当前本地时间，并追加一条测试日志。')
      expect(html).toContain('查看定时任务')
      expect(html).not.toContain('data-message-role="user"')
      expect(html).not.toContain('PROFER_SCHEDULED_RUN')
      expect(html).not.toContain('修改重发')
      expect(html).not.toContain('原配置已更新')
    }
    expect(during).toBe(history)
    const groups = groupIntoTurns(projectTaskInputTimeline([scheduled, input]))
    const nav = buildNavigationItems(buildNavigationEntries([scheduled, input]), groups, 'user-avatar', [scheduled, input])
    expect(nav).toHaveLength(1)
    expect(nav[0]!.role).toBe('status')
    expect(nav[0]!.avatar).toBeUndefined()
    for (const streaming of [true, false]) {
      const html = renderToStaticMarkup(React.createElement(Provider, { store }, React.createElement(AgentMessages, {
        sessionId: 'automation-session', messagesLoaded: true, persistedSDKMessages: [scheduled, input],
        liveMessages: streaming ? [structuredClone(scheduled), structuredClone(input)] : [], streaming,
      })))
      expect(html.match(/data-testid="task-trigger-notice"/g)).toHaveLength(1)
      expect(html).not.toContain('data-message-role="user"')
    }
    expect(render(React.createElement(SDKMessageRenderer, { message: scheduled, allMessages: [scheduled, input] }))).toBe('')
    const legacy = render(React.createElement(SDKMessageRenderer, { message: { ...input, _provenance: undefined }, allMessages: [] }))
    expect(legacy).toContain('定时任务触发')
    expect(legacy).toContain('追加一条测试日志')
    expect(legacy).not.toContain('查看定时任务')
  })

  test('子会话交接正文合入一张来源卡，沿用正文字号并与头像左缘对齐', () => {
    const task = { type: 'user', parent_tool_use_id: null, _createdAt: 200,
      message: { content: [{ type: 'text', text: '核对缓存逻辑并返回验证证据。' }] },
      _provenance: { ...notice._provenance!, messageId: 'handoff-input' },
    } as SDKMessage
    const store = createStore()
    store.set(agentSessionsAtom, [{ id: 'source-session', title: '父会话', createdAt: 1, updatedAt: 1 }])
    const html = renderToStaticMarkup(React.createElement(Provider, { store }, React.createElement(AgentMessages, {
      sessionId: 'child', messagesLoaded: true, persistedSDKMessages: [notice, task], liveMessages: [structuredClone(task)], streaming: true,
    })))
    expect(html.match(/data-testid="task-trigger-notice"/g)).toHaveLength(1)
    expect(html).toContain('Agent 任务交接')
    expect(html).toContain('核对缓存逻辑并返回验证证据。')
    expect(html).toContain('来自会话「父会话」')
    expect(html).toContain('查看来源会话')
    expect(html).not.toContain('data-message-role="user"')
    expect(html).toContain('my-3 mx-2.5 min-w-0 text-[length:var(--md-preview-font-size,15px)] leading-[1.6]')
    expect(html).not.toContain('my-3 pl-[46px]')
    expect(render(React.createElement(SDKMessageRenderer, { message: task, allMessages: [notice, task] }))).toContain('Agent 任务交接')
  })

  test('子会话兜底回传在父时间线的原始消息处逐条显示可跳转工具条，普通工具结果不显示', () => {
    const fallback: SDKMessage = {
      type: 'user', parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: '所有协作子会话均已结束。请继续完成原始任务。' }] },
      _provenance: { schemaVersion: 1, messageId: 'fallback', author: { type: 'system' }, runId: 'parent-run', triggerId: 'fallback-trigger' },
      _taskReturnReferences: [
        { sessionId: 'child-a', title: '检索实现方案', status: 'completed', summary: '建议保留当前接口。' },
        { sessionId: 'child-b', title: '核对风险', status: 'failed', summary: '发现两项需要关注的风险。' },
      ],
    } as SDKMessage
    const store = createStore()
    store.set(agentSessionsAtom, [
      { id: 'child-a', title: '检索实现方案', createdAt: 1, updatedAt: 1 },
      { id: 'child-b', title: '核对风险', createdAt: 1, updatedAt: 1 },
    ])
    const preceding = { ...assistant('先前'), _createdAt: 100 }
    const fallbackMessage = { ...fallback, _createdAt: 200 }
    const following = { ...assistant('续跑回答'), _createdAt: 300 }
    const html = renderToStaticMarkup(React.createElement(Provider, { store }, React.createElement(AgentMessages, {
      sessionId: 'parent', messagesLoaded: true, persistedSDKMessages: [preceding, fallbackMessage, following], streaming: false,
    })))
    expect(html.match(/data-testid="task-return-section"/g)).toHaveLength(1)
    expect(html).toContain('子会话返回')
    expect(html).not.toContain('展开返回内容')
    expect(html.match(/data-testid="task-return-card"/g)).toHaveLength(2)
    expect(html).toContain('子会话返回 · 已完成')
    expect(html).toContain('子会话返回 · 失败')
    expect(html).toContain('检索实现方案')
    expect(html).toContain('核对风险')
    expect(html).toContain('title="返回子会话「检索实现方案」查看"')
    expect(html).toContain('title="返回子会话「核对风险」查看"')
    expect(html).not.toContain('展开返回内容')
    expect(html).not.toContain('收起返回内容')
    expect(html).not.toContain('建议保留当前接口。')
    expect(html).not.toContain('发现两项需要关注的风险。')
    expect(html).not.toContain('来自上级任务')
    expect(html.indexOf('data-testid="task-return-section"')).toBeGreaterThan(html.indexOf('子会话返回'))
    expect(html.indexOf('data-testid="task-return-section"')).toBeLessThan(html.indexOf('续跑回答'))
    const ordinaryToolResult = { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'get-result', content: JSON.stringify({ childSessionId: 'child-a', result: '主动查询的结果' }) }] } } as SDKMessage
    const ordinary = render(React.createElement(SDKMessageRenderer, { message: ordinaryToolResult, allMessages: [ordinaryToolResult] }))
    expect(ordinary).not.toContain('task-return-section')
  })

  test('历史来源缺失时显示未知作者，不按 system role 猜测为框架', () => {
    const html = render(React.createElement(SDKMessageRenderer, { message: { ...notice, _provenance: undefined }, allMessages: [] }))
    expect(html).toContain('历史任务来源')
    expect(html).not.toContain('dispatch-agent')
  })
})
