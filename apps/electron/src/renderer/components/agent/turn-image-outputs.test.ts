import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import { collectTurnImageOutputs } from './turn-image-outputs'

const image = {
  localPath: '/tmp/session/.context/agent-output-images/a.png',
  filename: 'a.png',
  mediaType: 'image/png' as const,
}

function assistantToolUse(id: string, name: string): SDKMessage {
  return {
    type: 'assistant',
    uuid: `assistant-${id}`,
    message: { content: [{ type: 'tool_use', id, name, input: {} }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

function toolResult(id: string, details: unknown): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'ok' }] }] },
    tool_use_result: details,
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

describe('turn image outputs', () => {
  test('Given send_local_image 与 generate_image 的结构化结果 When 收集 Then 按工具调用 id 归集图片', () => {
    const outputs = collectTurnImageOutputs([
      assistantToolUse('send-1', 'send_local_image'),
      toolResult('send-1', { image }),
      assistantToolUse('gen-1', 'generate_image'),
      toolResult('gen-1', { image: { ...image, localPath: '/tmp/b.png', filename: 'b.png' } }),
    ])

    expect([...outputs.keys()]).toEqual(['send-1', 'gen-1'])
    expect(outputs.get('send-1')).toEqual([image])
  })

  test('Given 非图片工具返回同样结构 When 收集 Then 不提升为图片输出，保留其工具行', () => {
    const outputs = collectTurnImageOutputs([
      assistantToolUse('other-1', 'Read'),
      toolResult('other-1', { image }),
    ])

    expect(outputs.size).toBe(0)
  })

  test('Given 兼容结构的 details When 收集 Then 仍能提取图片', () => {
    const outputs = collectTurnImageOutputs([
      assistantToolUse('send-1', 'send_local_image'),
      toolResult('send-1', { output: { image }, details: { structuredContent: { image } } }),
    ])

    expect(outputs.get('send-1')).toEqual([image])
  })

  test('Given 只有正文里的旧标记 When 收集 Then 不进入 turn 级图片块（旧会话仍由文本渲染兜底）', () => {
    const outputs = collectTurnImageOutputs([
      assistantToolUse('send-1', 'send_local_image'),
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: `[PROFER_IMAGE_ATTACHMENT:${JSON.stringify(image)}]` }] },
      } as unknown as SDKMessage,
    ])

    expect(outputs.size).toBe(0)
  })
})
