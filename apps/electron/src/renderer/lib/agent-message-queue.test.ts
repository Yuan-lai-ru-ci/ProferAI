import { describe, expect, test } from 'bun:test'

import {
  createAgentQueuedMessage,
  moveQueuedMessage,
  queuedTextToParagraphHtml,
  removeQueuedMessage,
  restoreQueuedMessageToFront,
  shouldRestoreQueuedMessageAfterFailure,
  type AgentQueuedMessage,
} from './agent-message-queue'

const message = (id: string, text = id): AgentQueuedMessage => createAgentQueuedMessage(text, id, 1)

describe('队列增删与排序', () => {
  test('Given 新建消息 When 入队 Then 正文被 trim 且不带引用字段', () => {
    const item = createAgentQueuedMessage('  先补单测  ', 'm1', 42)
    expect(item).toEqual({ id: 'm1', text: '先补单测', createdAt: 42 })
  })

  test('Given 三条消息 When 删除中间一条 Then 其余顺序不变', () => {
    const queue = [message('a'), message('b'), message('c')]
    expect(removeQueuedMessage(queue, 'b').map((i) => i.id)).toEqual(['a', 'c'])
  })

  test('Given 四条消息 When 把第四条拖到第二条之后 Then 顺序按插入点重排', () => {
    const queue = [message('a'), message('b'), message('c'), message('d')]
    expect(moveQueuedMessage(queue, 'd', 'b', 'after').map((i) => i.id)).toEqual(['a', 'b', 'd', 'c'])
    expect(moveQueuedMessage(queue, 'd', 'b', 'before').map((i) => i.id)).toEqual(['a', 'd', 'b', 'c'])
  })

  test('Given 拖到自己身上或目标不存在 When 移动 Then 队列引用不变', () => {
    const queue = [message('a'), message('b')]
    expect(moveQueuedMessage(queue, 'a', 'a', 'after')).toBe(queue)
    expect(moveQueuedMessage(queue, 'a', 'missing', 'after')).toBe(queue)
  })

  test('Given 发送失败 When 回队首 Then 去重后放在最前', () => {
    const queue = [message('b'), message('c')]
    expect(restoreQueuedMessageToFront(queue, message('a')).map((i) => i.id)).toEqual(['a', 'b', 'c'])
    // 已在队列里不重复插入
    expect(restoreQueuedMessageToFront(queue, message('b')).map((i) => i.id)).toEqual(['b', 'c'])
  })

  test('Given 停止发生在发送期间 When 判定回队资格 Then 只有同一 epoch 且未停止才回队', () => {
    expect(shouldRestoreQueuedMessageAfterFailure(1, 1, false)).toBe(true)
    expect(shouldRestoreQueuedMessageAfterFailure(1, 2, false)).toBe(false)
    expect(shouldRestoreQueuedMessageAfterFailure(1, 1, true)).toBe(false)
  })
})

describe('撤回草稿 HTML', () => {
  test('Given 多行文本 When 转段落 Then 空行分段、单换行转 br 并转义标签', () => {
    expect(queuedTextToParagraphHtml('第一段\n换行\n\n第二段 <b>'))
      .toBe('<p>第一段<br>换行</p><p>第二段 &lt;b&gt;</p>')
  })
})
