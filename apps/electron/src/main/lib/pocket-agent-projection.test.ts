import { describe, expect, test } from 'bun:test'
import { projectAgentPayloadForPocket, projectSdkMessageForPocket } from './pocket-agent-projection'

const large = 'private tool data '.repeat(1000)

describe('Pocket 远程 Agent 投影', () => {
  test('保留有界思考预览，不下发工具入参', () => {
    const projected = projectSdkMessageForPocket({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: large },
          { type: 'text', text: '完成' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: large } },
        ],
      },
      parent_tool_use_id: null,
    }) as never as {
      message: { content: [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>] }
    }
    const [thinking, text, tool] = projected.message.content
    expect(text).toEqual({ type: 'text', text: '完成' })
    // 入参照旧不下发，只多一行有界摘要（移动端要靠它区分「哪一步在干什么」）
    expect(tool).toMatchObject({ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} })
    expect(tool?.summary).toMatch(/^private tool data private tool data/)
    expect(String(tool?.summary).length).toBe(121)
    expect(String(tool?.summary).endsWith('…')).toBe(true)
    // final 帧思考上限 2000 字符，保留结尾；整条消息不再携带 18k 的原始思考。
    expect(thinking.type).toBe('thinking')
    expect(String(thinking.thinking).startsWith('…')).toBe(true)
    expect(String(thinking.thinking).length).toBe(2001)
    expect(String(thinking.thinking).endsWith('private tool data')).toBe(true)
    expect(JSON.stringify(projected).length).toBeLessThan(4000)
  })

  test('partial 思考只带尾部窗口，避免每帧重发全文', () => {
    const projected = projectSdkMessageForPocket({
      type: 'assistant',
      _partial: true,
      uuid: 'a1',
      message: {
        content: [
          { type: 'thinking', thinking: `${'早期推理。'.repeat(300)}最新结论` },
          { type: 'text', text: '正在处理' },
        ],
      },
      parent_tool_use_id: null,
    }) as never as { message: { content: Array<Record<string, unknown>> } }
    const thinking = projected.message.content.find((block) => block.type === 'thinking')
    expect(thinking).toBeDefined()
    expect(String(thinking?.thinking).length).toBe(801)
    expect(String(thinking?.thinking).endsWith('最新结论')).toBe(true)
  })

  test('空思考不产生思考块', () => {
    const projected = projectSdkMessageForPocket({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: '   ' }, { type: 'text', text: 'ok' }] },
      parent_tool_use_id: null,
    }) as never as { message: { content: Array<Record<string, unknown>> } }
    expect(projected.message.content).toEqual([{ type: 'text', text: 'ok' }])
  })

  test('assistant 只透传上下文用量需要的四个 token 计数', () => {
    const projected = projectSdkMessageForPocket({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'ok' }],
        usage: {
          input_tokens: 1200,
          output_tokens: 80,
          cache_read_input_tokens: 300,
          cache_creation_input_tokens: 40,
          service_tier: 'standard',
          server_tool_use: { web_search_requests: 2 },
        },
      },
      parent_tool_use_id: null,
    }) as never as { message: { usage?: Record<string, unknown> } }
    expect(projected.message.usage).toEqual({
      input_tokens: 1200,
      output_tokens: 80,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 40,
    })
    expect(JSON.stringify(projected)).not.toContain('service_tier')
  })

  test('工具结果里的图片只下发引用，不下发字节', () => {
    const projected = projectSdkMessageForPocket({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-9', content: [{ type: 'text', text: '图片已复制' }] }] },
      tool_use_result: {
        content: [{ type: 'text', text: '图片已复制' }],
        details: {
          image: {
            localPath: '/Users/mac/.profer/agent-workspaces/profer/s1/.context/agent-output-images/a.png',
            relativePath: '.context/agent-output-images/a.png',
            absolutePath: '/Users/mac/.profer/agent-workspaces/profer/s1/.context/agent-output-images/a.png',
            filename: 'a.png',
            mediaType: 'image/png',
            base64: 'A'.repeat(5000),
          },
        },
      },
    } as never) as never as { message: { content: Array<Record<string, unknown>> } }

    expect(projected.message.content).toEqual([{
      type: 'tool_result',
      tool_use_id: 'tool-9',
      images: [{
        path: '/Users/mac/.profer/agent-workspaces/profer/s1/.context/agent-output-images/a.png',
        filename: 'a.png',
        mediaType: 'image/png',
      }],
    }])
    expect(JSON.stringify(projected)).not.toContain('base64')
  })

  test('非位图或超量图片被丢弃', () => {
    const image = (index: number, mediaType = 'image/png'): Record<string, unknown> => ({
      localPath: `/tmp/img-${index}.png`,
      filename: `img-${index}.png`,
      mediaType,
    })
    const projected = projectSdkMessageForPocket({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1' }] },
      tool_use_result: {
        imageAttachments: [image(1, 'image/svg+xml'), image(2), image(3), image(4), image(5), image(6), image(7)],
      },
    } as never) as never as { message: { content: Array<{ images?: Array<Record<string, unknown>> }> } }

    const images = projected.message.content[0]?.images ?? []
    expect(images).toHaveLength(4)
    expect(images.map((item) => item.filename)).toEqual(['img-2.png', 'img-3.png', 'img-4.png', 'img-5.png'])
  })

  test('SDK 消息投影只透传 provenance，不透传授权、凭据或路径字段', () => {
    const provenance = { schemaVersion: 1, messageId: 'm1', author: { type: 'agent', id: 'worker' }, runId: 'run-1', taskId: 'task-1', triggerId: 'trigger-1', source: { type: 'session', id: 'source' } }
    const projected = projectSdkMessageForPocket({
      type: 'user', uuid: 'm1', _provenance: provenance,
      authorization: { token: 'secret' }, absolutePath: '/private/root',
      message: { content: [{ type: 'text', text: '交接' }] },
    } as never) as never as Record<string, unknown>
    expect(projected._provenance).toEqual(provenance)
    expect(projected).not.toHaveProperty('authorization')
    expect(projected).not.toHaveProperty('absolutePath')
  })

  test('非 SDK 事件保持原样，SDK 事件经过投影', () => {
    const proferEvent = { kind: 'profer_event', event: { type: 'run_resumed' } } as never
    expect(projectAgentPayloadForPocket(proferEvent)).toBe(proferEvent)

    const payload = projectAgentPayloadForPocket({
      kind: 'sdk_message',
      message: { type: 'assistant', message: { content: [{ type: 'thinking', thinking: large }] }, parent_tool_use_id: null },
    } as never) as never as { message: { message: { content: Array<Record<string, unknown>> } } }
    expect(payload.message.message.content).toHaveLength(1)
    expect(payload.message.message.content[0]?.type).toBe('thinking')
  })
})

describe('工具入参摘要（移动端「执行过程」每行那一句话）', () => {
  const projectTool = (name: string, input: Record<string, unknown>): Record<string, unknown> => {
    const projected = projectSdkMessageForPocket({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name, input }] },
      parent_tool_use_id: null,
    } as never) as never as { message: { content: Array<Record<string, unknown>> } }
    return projected.message.content[0]!
  }

  test('Given 多行 Bash 命令 When 投影 Then 折成一行，仍不带上完整命令', () => {
    const tool = projectTool('Bash', { command: 'cd /d/ProferAI\nbun run typecheck\nbun test webui/' })
    expect(tool.summary).toBe('cd /d/ProferAI bun run typecheck bun test webui/')
    expect(tool.input).toEqual({})
  })

  test('Given MCP 工具带 prompt 与 id When 投影 Then 摘要取 prompt 而不是 id', () => {
    const tool = projectTool('mcp__collaboration__delegate_agent', {
      agent: 'reviewer',
      prompt: '一行原文结论，不要复述过程。',
      id: 'sess-123',
    })
    expect(tool.summary).toBe('一行原文结论，不要复述过程。')
  })

  test('Given 只有业务 id When 投影 Then 退回到那个字符串，行为不空白', () => {
    const tool = projectTool('mcp__automation__delete_automation', { automationId: '1aa622a2-6fb0-4b71-8dd3-ea5d51b9a512' })
    expect(tool.summary).toBe('1aa622a2-6fb0-4b71-8dd3-ea5d51b9a512')
  })

  test('Given 全是非字符串入参 When 投影 Then 干脆不挂 summary 字段', () => {
    const tool = projectTool('TodoWrite', { todos: [{ a: 1 }] })
    expect('summary' in tool).toBe(false)
  })

  test('Given 超长摘要 When 投影 Then 截到 120 字加省略号，WebSocket 不被撑大', () => {
    const tool = projectTool('WebFetch', { url: `https://example.com/${'x'.repeat(400)}` })
    expect(String(tool.summary)).toHaveLength(121)
    expect(String(tool.summary).endsWith('…')).toBe(true)
  })

  test('Given 下划线开头的内部字段 When 投影 Then 不当作摘要（那是 SDK 内部标记）', () => {
    const tool = projectTool('mcp__x__y', { _internal: '不该显示', label: '该显示' })
    expect(tool.summary).toBe('该显示')
  })
})

describe('消息来源标记（WebUI 用来标注「这条是网页发的」）', () => {
  test('Given user 消息带 _clientId When 投影 Then 原样保留', () => {
    const projected = projectSdkMessageForPocket({
      type: 'user',
      uuid: 'u1',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: '你好' }] },
      _clientId: 'webui',
      _createdAt: 1794558663188,
    } as never) as never as Record<string, unknown>
    expect(projected._clientId).toBe('webui')
    expect(projected._createdAt).toBe(1794558663188)
  })

  test('Given 桌面端消息没有标记 When 投影 Then 不带 _clientId（缺省即软件）', () => {
    const projected = projectSdkMessageForPocket({
      type: 'user',
      uuid: 'u2',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: '你好' }] },
    } as never) as never as Record<string, unknown>
    expect(projected._clientId).toBeUndefined()
  })
})
