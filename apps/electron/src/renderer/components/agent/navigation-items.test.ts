import { describe, expect, test } from 'bun:test'
import type { AgentNavigationIndexEntry, SDKMessage } from '@profer/shared'
import type { MessageGroup } from './SDKMessageRenderer'
import { appendLocalOnlyItems, buildNavigationItems, navItemKey, navigationItemFromGroup } from './navigation-items'

function userGroup(uuid: string, createdAt = 1000): MessageGroup {
  return {
    type: 'user',
    message: {
      type: 'user',
      message: { content: [{ type: 'text', text: `用户 ${uuid}` }] },
      parent_tool_use_id: null,
      uuid,
      _createdAt: createdAt,
    },
  } as unknown as MessageGroup
}

function assistantGroup(uuid: string, createdAt = 1000, model = 'gpt-x'): MessageGroup {
  return {
    type: 'assistant-turn',
    assistantMessages: [{
      type: 'assistant',
      message: { content: [{ type: 'text', text: `答复 ${uuid}` }], model },
      parent_tool_use_id: null,
      uuid,
      _createdAt: createdAt,
    }],
    turnMessages: [],
    model,
    createdAt,
  } as unknown as MessageGroup
}

function interruptionGroup(createdAt = 1000): MessageGroup {
  return {
    type: 'system',
    message: { type: 'system', subtype: 'interruption_record', message: '已被用户中断', _createdAt: createdAt },
  } as unknown as MessageGroup
}

const entry = (over: Partial<AgentNavigationIndexEntry> = {}): AgentNavigationIndexEntry => ({
  id: 'u1',
  role: 'user',
  preview: '一',
  matchKey: 'user::1000',
  ...over,
})

describe('导航条目组装 · 全量索引为骨架', () => {
  test('Given 索引覆盖全会话 When 本地只加载尾部 Then 总数取索引而非本地', () => {
    // 现场还原：会话共 16 轮，本地只加载了最后 2 轮（索引里已含这两轮）。
    const index: AgentNavigationIndexEntry[] = []
    for (let i = 0; i < 8; i++) {
      index.push(entry({ id: `u${i}`, preview: `问 ${i}`, matchKey: `user::${1000 + i}` }))
      index.push(entry({ id: `a${i}`, role: 'assistant', preview: `答 ${i}`, matchKey: `assistant::${1000 + i}` }))
    }
    const local = [userGroup('u7'), assistantGroup('a7')]

    const items = buildNavigationItems(index, local, 'avatar.png')

    expect(items).toHaveLength(16)
    expect(items.map((it) => it.preview)).toEqual(index.map((e) => e.preview))
  })

  test('Given 索引里的用户消息 When 本地已加载 Then 补上头像', () => {
    const items = buildNavigationItems([entry({ id: 'u1' }), entry({ id: 'a1', role: 'assistant', matchKey: 'assistant::1000' })], [userGroup('u1'), assistantGroup('a1')], 'avatar.png')

    expect(items[0]!.avatar).toBe('avatar.png')
    expect(items[1]!.avatar).toBeUndefined()
  })

  test('子会话兜底返回在实时导航中作为独立状态轮，预览包含子会话名称', () => {
    const returned = {
      type: 'user',
      message: { content: [{ type: 'text', text: '内部续跑提示正文' }] },
      parent_tool_use_id: null,
      uuid: 'return-1',
      _createdAt: 2000,
      _provenance: { schemaVersion: 1, messageId: 'return-1', author: { type: 'system' }, runId: 'run-1', triggerId: 'trigger-1' },
      _taskReturnReferences: [
        { sessionId: 'child-a', title: '检索实现', status: 'completed', summary: '摘要' },
        { sessionId: 'child-b', title: '核对风险', status: 'failed', summary: '摘要' },
      ],
    } as unknown as SDKMessage
    const group = { type: 'user', message: returned } as unknown as MessageGroup

    expect(navigationItemFromGroup(group)).toMatchObject({
      id: 'return-1', role: 'status', startsTurn: true,
      preview: '子会话返回：检索实现、核对风险',
    })
  })
  test('Given 无 uuid 的中断行 When 本地已加载 Then 靠 matchKey 补头像/定位而不靠 id', () => {
    const index = [
      entry({ id: null, role: 'status', preview: '已被用户中断', matchKey: 'status:interruption_record:1000' }),
    ]
    const items = buildNavigationItems(index, [interruptionGroup()], 'avatar.png')

    expect(items).toHaveLength(1)
    expect(items[0]!.id).toBeNull()
    expect(items[0]!.matchKey).toBe('status:interruption_record:1000')
    expect(navItemKey(items[0]!)).toBe('key:status:interruption_record:1000')
  })

  test('Given 刚发一轮尚未落盘 When 索引未含该轮 Then 追加到末尾且不重复历史', () => {
    const index = [entry({ id: 'u1' }), entry({ id: 'a1', role: 'assistant', matchKey: 'assistant::1000' })]
    const local = [userGroup('u1'), assistantGroup('a1'), userGroup('u2', 2000), assistantGroup('a2', 2000)]

    const items = buildNavigationItems(index, local, undefined)

    expect(items.map((it) => it.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  test('Given 索引预览里带着内部 XML When 组装 Then 只显示用户自己的话', () => {
    // 旧版本主进程的索引 / 进程内缓存可能还是带 <quoted_context> 的旧预览，
    // 展示层再洗一遍，不能让整段 XML 冒到迷你地图上。
    const index = [
      entry({
        id: 'u1',
        preview: '<quoted_context source="agent-interruption" label="已被用户中断" message_id="" role="">\n上次任务被中断\n</quoted_context>\n\n帮我把它的签名搞定，然后打开',
      }),
    ]

    const items = buildNavigationItems(index, [], undefined)

    expect(items[0]!.preview).toBe('帮我把它的签名搞定，然后打开')
  })

  test('Given 索引为空 When 本地有分组 Then 回退到本地（不阻塞会话）', () => {
    const local = [userGroup('u1'), assistantGroup('a1')]

    const items = buildNavigationItems([], local, 'avatar.png')

    expect(items.map((it) => it.id)).toEqual(['u1', 'a1'])
    expect(items[0]!.avatar).toBe('avatar.png')
  })

  test('Given 索引为 null When 本地有分组 Then 同样回退到本地', () => {
    const items = buildNavigationItems(null, [userGroup('u1')], undefined)
    expect(items.map((it) => it.id)).toEqual(['u1'])
  })
})

describe('导航条目组装 · 去重语义', () => {
  test('Given 索引与本地完全重叠 When 追加 Then 不产生重复项', () => {
    const index = [entry({ id: 'u1' }), entry({ id: 'a1', role: 'assistant', matchKey: 'assistant::1000' })]
    const extra = appendLocalOnlyItems(index, [userGroup('u1'), assistantGroup('a1')])
    expect(extra).toEqual([])
  })

  test('Given 本地尾部多了两轮 When 追加 Then 按原顺序只补新增', () => {
    const index = [entry({ id: 'u1' })]
    const extra = appendLocalOnlyItems(index, [
      userGroup('u1'),
      userGroup('u2', 2000),
      assistantGroup('a2', 2000),
      userGroup('u3', 3000),
    ])
    expect(extra.map((it) => it.id)).toEqual(['u2', 'a2', 'u3'])
  })
})
