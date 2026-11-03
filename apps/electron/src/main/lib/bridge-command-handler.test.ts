import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRuntime, AgentSessionMeta, ChannelsConfig } from '@profer/shared'

// ===== 渠道配置夹具（真实 channel-manager 读取） =====
const configDir = mkdtempSync(join(tmpdir(), 'profer-bridge-command-handler-'))
const channelsPath = join(configDir, 'channels.json')
const originalConfigDir = process.env.PROFER_CONFIG_DIR

function channel(
  id: string,
  agentRuntimes: Array<'pi' | 'claude'>,
): ChannelsConfig['channels'][number] {
  return {
    id,
    name: id,
    provider: 'custom',
    baseUrl: 'https://example.com/v1',
    agentBaseUrl: 'https://example.com/v1',
    apiKey: 'test-secret',
    models: [{ id: `${id}-model`, name: `${id} model`, enabled: true }],
    enabled: true,
    agentRuntimes,
    createdAt: 1,
    updatedAt: 1,
  }
}

function writeChannels(): void {
  writeFileSync(
    channelsPath,
    JSON.stringify({
      version: 1,
      channels: [channel('pi-only', ['pi']), channel('claude-only', ['claude']), channel('dual', ['pi', 'claude'])],
    }, null, 2),
    'utf-8',
  )
}

// ===== 设置夹具 =====
interface SettingsFixture {
  agentRuntime: AgentRuntime
  agentChannelId?: string
  agentModelId?: string
  agentWorkspaceId?: string
}

let settings: SettingsFixture = { agentRuntime: 'pi', agentChannelId: 'pi-only' }

// ===== 会话夹具 =====
interface CreatedSessionCall {
  title?: string
  channelId?: string
  workspaceId?: string
  modelId?: string
  agentRuntime?: AgentRuntime
}

const createdSessionCalls: CreatedSessionCall[] = []
const sessionMetas = new Map<string, AgentSessionMeta>()
let sessionSeq = 0
/** 模拟建会话失败（project 根被移走 / 目录不可写）。 */
let failSessionCreation: Error | null = null

function seedSession(meta: Partial<AgentSessionMeta> & { id: string }): AgentSessionMeta {
  const full = {
    title: meta.id,
    channelId: 'pi-only',
    agentRuntime: 'pi',
    agentRuntimeLocked: true,
    createdAt: 1,
    updatedAt: 1,
    ...meta,
  } as AgentSessionMeta
  sessionMetas.set(full.id, full)
  return full
}

// ===== 被 mock 的本地依赖 =====
mock.module('./settings-service', () => ({
  getSettings: () => settings,
}))

mock.module('./agent-session-manager', () => ({
  createAgentSession: (
    title?: string,
    channelId?: string,
    workspaceId?: string,
    modelId?: string,
    agentRuntime?: AgentRuntime,
  ) => {
    if (failSessionCreation) throw failSessionCreation
    createdSessionCalls.push({ title, channelId, workspaceId, modelId, agentRuntime })
    const id = `session-${++sessionSeq}`
    return seedSession({
      id,
      title: title ?? '新会话',
      channelId,
      agentRuntime: agentRuntime ?? 'claude',
      agentRuntimeLocked: false,
    })
  },
  listAgentSessions: () => Array.from(sessionMetas.values()),
  getAgentSessionMeta: (id: string) => sessionMetas.get(id),
}))

const headlessCalls: Array<{
  sessionId: string
  channelId: string
  modelId?: string
  userMessage?: string
  rawUserMessage?: string
}> = []

mock.module('./agent-service', () => ({
  runAgentHeadless: async (input: {
    sessionId: string
    channelId: string
    modelId?: string
    userMessage?: string
    rawUserMessage?: string
  }) => {
    headlessCalls.push({
      sessionId: input.sessionId,
      channelId: input.channelId,
      modelId: input.modelId,
      userMessage: input.userMessage,
      rawUserMessage: input.rawUserMessage,
    })
  },
  agentEventBus: { on: () => () => {} },
  stopAgent: () => {},
  isAgentSessionActive: () => false,
}))

mock.module('./agent-workspace-manager', () => ({
  listAgentWorkspacesByUpdatedAt: () => [],
  getAgentWorkspace: () => undefined,
  getWorkspaceCapabilities: () => ({ mcpServers: [], skills: [] }),
}))

const { BridgeCommandHandler } = await import('./bridge-command-handler')

function createHandler(): { handler: InstanceType<typeof BridgeCommandHandler>; sent: string[] } {
  const sent: string[] = []
  const handler = new BridgeCommandHandler({
    platformName: '测试',
    source: 'dingtalk',
    adapter: {
      sendText: async (_chatId: string, text: string) => {
        sent.push(text)
      },
    },
  })
  return { handler, sent }
}

beforeEach(() => {
  process.env.PROFER_CONFIG_DIR = configDir
  writeChannels()
  settings = { agentRuntime: 'pi', agentChannelId: 'pi-only' }
  createdSessionCalls.length = 0
  headlessCalls.length = 0
  sessionMetas.clear()
  sessionSeq = 0
  failSessionCreation = null
})

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe('Bot 建会话使用全局 Agent 内核', () => {
  test('Given 全局内核 Pi 且默认渠道 Pi-only When 收到消息 Then 建会话传 pi 并写入 binding', async () => {
    const { handler, sent } = createHandler()

    await handler.handleIncomingMessage('chat-1', '你好')

    expect(createdSessionCalls).toHaveLength(1)
    expect(createdSessionCalls[0]?.agentRuntime).toBe('pi')
    expect(createdSessionCalls[0]?.channelId).toBe('pi-only')
    expect(handler.getBinding('chat-1')?.agentRuntime).toBe('pi')
    // 发送路径同样使用 Pi-only 渠道，而不是退回 Claude 渠道
    expect(headlessCalls[0]?.channelId).toBe('pi-only')
    expect(sent.some((line) => line.includes('Agent 处理中'))).toBe(true)
  })

  test('Given 全局内核 Pi When /new 建会话 Then 也传 pi', async () => {
    const { handler } = createHandler()

    await handler.handleIncomingMessage('chat-2', '/new 测试会话')

    expect(createdSessionCalls[0]?.agentRuntime).toBe('pi')
    expect(handler.getBinding('chat-2')?.agentRuntime).toBe('pi')
  })

  test('Given 默认渠道只勾选 Claude 而全局内核是 Pi When 建会话 Then 回退到 Pi 可用渠道并提示', async () => {
    settings = { agentRuntime: 'pi', agentChannelId: 'claude-only' }
    const { handler, sent } = createHandler()

    await handler.handleIncomingMessage('chat-3', '/new')

    expect(createdSessionCalls[0]?.channelId).toBe('pi-only')
    expect(createdSessionCalls[0]?.agentRuntime).toBe('pi')
    expect(sent.some((line) => line.includes('已自动改用其它可用渠道'))).toBe(true)
  })
})

describe('/model 按会话内核过滤', () => {
  test('Given Pi 会话 When 查看渠道列表 Then 不出现只勾选 Claude 的渠道', async () => {
    const { handler, sent } = createHandler()
    await handler.handleIncomingMessage('chat-4', 'hi')

    await handler.handleIncomingMessage('chat-4', '/model')

    const listMessage = sent.at(-1) ?? ''
    expect(listMessage).toContain('pi-only')
    expect(listMessage).toContain('dual')
    expect(listMessage).not.toContain('claude-only')
    expect(listMessage).toContain('当前内核: Pi')
  })

  test('Given 旧 binding 无 agentRuntime When 会话元数据是 Claude Then 按 Claude 过滤并允许切换', async () => {
    const { handler, sent } = createHandler()
    // 先用 Pi 建会话，再模拟旧持久化数据：binding 没有 agentRuntime，会话元数据是 Claude
    const binding = handler.ensureBinding('chat-5')
    expect(binding).not.toBeNull()
    delete binding!.agentRuntime
    seedSession({ id: binding!.sessionId, agentRuntime: 'claude', channelId: 'pi-only' })

    await handler.handleIncomingMessage('chat-5', '/model')
    const listMessage = sent.at(-1) ?? ''
    expect(listMessage).toContain('当前内核: Claude')
    expect(listMessage).toContain('claude-only')
    expect(listMessage).not.toContain('pi-only')

    // 序号 1 在 Claude 列表里是 claude-only，切换必须成功
    await handler.handleIncomingMessage('chat-5', '/model 1 1')
    expect(handler.getBinding('chat-5')?.channelId).toBe('claude-only')
  })

  test('Given Pi 会话 When 选择不存在的序号 Then 明确提示当前内核而不是静默失败', async () => {
    const { handler, sent } = createHandler()
    await handler.handleIncomingMessage('chat-6', 'hi')

    // Pi 可用渠道只有 2 个，序号 3 越界
    await handler.handleIncomingMessage('chat-6', '/model 3')

    const reply = sent.at(-1) ?? ''
    expect(reply).toContain('未找到渠道')
    expect(reply).toContain('当前内核: Pi')
    expect(handler.getBinding('chat-6')?.channelId).toBe('pi-only')
  })

  test('Given 没有该内核可用渠道 When 查看渠道列表 Then 给出明确提示', async () => {
    settings = { agentRuntime: 'claude', agentChannelId: 'pi-only' }
    writeFileSync(
      channelsPath,
      JSON.stringify({ version: 1, channels: [channel('pi-only', ['pi'])] }, null, 2),
      'utf-8',
    )
    const { handler, sent } = createHandler()
    // 无 binding 时按全局设置解析内核（Claude），但没有任何 Claude 渠道
    await handler.handleIncomingMessage('chat-7', '/model')

    const reply = sent.at(-1) ?? ''
    expect(reply).toContain('暂无同时启用该内核的可用渠道')
    expect(reply).toContain('Claude')
  })
})

describe('旧 binding 发送时渠道回退', () => {
  test('Given binding 指向未启用当前内核的渠道 When 发送消息 Then 回退到可用渠道而不是报错', async () => {
    const { handler } = createHandler()
    const binding = handler.ensureBinding('chat-8')
    expect(binding).not.toBeNull()
    // 旧数据：会话是 Pi，但渠道被改成了只勾选 Claude 的渠道
    binding!.channelId = 'claude-only'
    binding!.agentRuntime = 'pi'

    await handler.handleIncomingMessage('chat-8', '继续')

    expect(headlessCalls[0]?.channelId).toBe('pi-only')
    // 回退后必须按新渠道重新解析模型，不能把 undefined/旧渠道模型交给 orchestrator。
    expect(headlessCalls[0]?.modelId).toBe('pi-only-model')
  })
})

describe('卡片渲染钩子', () => {
  interface CardHandlerOptions {
    withSendCard?: boolean
  }

  function createCardHandler(options: CardHandlerOptions = {}): {
    handler: InstanceType<typeof BridgeCommandHandler>
    sent: string[]
    cards: unknown[]
  } {
    const sent: string[] = []
    const cards: unknown[] = []
    const handler = new BridgeCommandHandler({
      platformName: '测试',
      source: 'dingtalk',
      adapter: {
        sendText: async (_chatId: string, text: string) => {
          sent.push(text)
        },
        ...(options.withSendCard === false
          ? {}
          : {
              sendCard: async (_chatId: string, card: unknown) => {
                cards.push(card)
              },
            }),
      },
      renderers: {
        help: () => ({ kind: 'help' }),
        sessionList: (input) => ({ kind: 'sessionList', input }),
        channelList: (input) => ({ kind: 'channelList', input }),
        now: (snapshot) => ({ kind: 'now', snapshot }),
      },
    })
    return { handler, sent, cards }
  }

  test('提供 sendCard 与渲染器时 /help 发卡片且不发文本', async () => {
    const { handler, sent, cards } = createCardHandler()
    await handler.handleIncomingMessage('card-1', '/help')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toEqual({ kind: 'help' })
    expect(sent).toHaveLength(0)
  })

  test('平台未提供 sendCard 时回退纯文本', async () => {
    const { handler, sent, cards } = createCardHandler({ withSendCard: false })
    await handler.handleIncomingMessage('card-2', '/help')
    expect(cards).toHaveLength(0)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('/help')
  })

  test('/list 卡片收到分组与当前标记', async () => {
    const { handler, cards } = createCardHandler()
    await handler.handleIncomingMessage('card-3', '/new 卡片会话')
    await handler.handleIncomingMessage('card-3', '/list')

    const card = cards.at(-1) as { kind: string; input: { groups: Array<{ name: string; sessions: Array<{ active: boolean; title: string }> }> } }
    expect(card.kind).toBe('sessionList')
    expect(card.input.groups[0]?.name).toBe('未分配工作区')
    expect(card.input.groups[0]?.sessions[0]?.title).toBe('卡片会话')
    expect(card.input.groups[0]?.sessions[0]?.active).toBe(true)
  })

  test('/model 卡片收到按内核过滤后的渠道列表', async () => {
    const { handler, cards } = createCardHandler()
    await handler.handleIncomingMessage('card-4', 'hi')
    await handler.handleIncomingMessage('card-4', '/model')

    const card = cards.at(-1) as { kind: string; input: { items: Array<{ name: string; isCurrent: boolean }> } }
    expect(card.kind).toBe('channelList')
    const names = card.input.items.map((item) => item.name)
    expect(names).toContain('pi-only')
    expect(names).not.toContain('claude-only')
  })
})

describe('/now 文本输出保持不变', () => {
  test('无渲染器时 /now 仍是纯文本状态摘要', async () => {
    const { handler, sent } = createHandler()
    await handler.handleIncomingMessage('now-1', '/new 状态会话')
    await handler.handleIncomingMessage('now-1', '/now')

    const reply = sent.at(-1) ?? ''
    expect(reply).toContain('📊 当前状态:')
    expect(reply).toContain('会话: 状态会话')
    expect(reply).toContain('内核:')
    // 测试夹具没有工作区，走「未设置」分支
    expect(reply).toContain('工作区: 未设置')
  })
})

describe('绑定与停止钩子', () => {
  function createHookHandler(): {
    handler: InstanceType<typeof BridgeCommandHandler>
    sent: string[]
    enriched: Array<{ binding: unknown; contextData: unknown }>
    bindingChanges: number[]
    stopped: string[]
  } {
    const sent: string[] = []
    const enriched: Array<{ binding: unknown; contextData: unknown }> = []
    const bindingChanges: number[] = []
    const stopped: string[] = []
    const handler = new BridgeCommandHandler({
      platformName: '测试',
      source: 'dingtalk',
      adapter: {
        sendText: async (_chatId: string, text: string) => {
          sent.push(text)
        },
      },
      enrichBinding: (binding, contextData) => {
        enriched.push({ binding, contextData })
      },
      afterBindingChanged: () => {
        bindingChanges.push(bindingChanges.length + 1)
      },
      afterStop: (sessionId) => {
        stopped.push(sessionId)
      },
    })
    return { handler, sent, enriched, bindingChanges, stopped }
  }

  test('/new 触发 enrichBinding 并收到透传的平台上下文', async () => {
    const { handler, enriched, bindingChanges } = createHookHandler()
    const ctx = { senderOpenId: 'ou_1', chatType: 'group' }

    await handler.handleIncomingMessage('hook-1', '/new', ctx)

    expect(enriched).toHaveLength(1)
    expect(enriched[0]?.contextData).toBe(ctx)
    expect((enriched[0]?.binding as { chatId: string }).chatId).toBe('hook-1')
    expect(bindingChanges.length).toBeGreaterThan(0)
  })

  test('/ws 无工作区时不会误删绑定', async () => {
    const { handler, bindingChanges } = createHookHandler()
    await handler.handleIncomingMessage('hook-2', '/new')
    const before = bindingChanges.length
    // 夹具里没有工作区，走「暂无工作区」分支，绑定必须原样保留
    await handler.handleIncomingMessage('hook-2', '/ws')
    expect(bindingChanges.length).toBe(before)
  })

  test('/stop 触发 afterStop 并传入会话 ID', async () => {
    const { handler, stopped } = createHookHandler()
    await handler.handleIncomingMessage('hook-3', '/new')
    const sessionId = handler.getBinding('hook-3')?.sessionId
    expect(sessionId).toBeDefined()

    await handler.handleIncomingMessage('hook-3', '/stop')

    expect(stopped).toEqual([sessionId as string])
  })
})

describe('可注入的绑定存储', () => {
  test('注入 Map 后命令写入的是同一份数据', async () => {
    const bindings = new Map<string, { chatId: string; sessionId: string; workspaceId: string; channelId: string }>()
    const sessionToChat = new Map<string, string>()
    const handler = new BridgeCommandHandler({
      platformName: '测试',
      source: 'feishu',
      adapter: { sendText: async () => {} },
      bindings: bindings as unknown as Map<string, import('./bridge-command-handler').BridgeChatBinding>,
      sessionToChat,
    })

    await handler.handleIncomingMessage('inject-1', '/new')

    expect(bindings.size).toBe(1)
    const sessionId = bindings.get('inject-1')?.sessionId as string
    expect(sessionToChat.get(sessionId)).toBe('inject-1')
  })
})


describe('IM 消息进桌面端的展示文本', () => {
  test('带附件时 userMessage 含 attached_files，rawUserMessage 只保留用户文本', async () => {
    const { handler } = createHandler()

    await handler.handleIncomingMessage('display-1', '看一下这个文件', undefined, [
      { absolutePath: '/tmp/a.png', label: 'a.png', kind: 'image' },
    ])

    const call = headlessCalls.at(-1)
    expect(call?.userMessage).toContain('<attached_files>')
    expect(call?.rawUserMessage).toBe('看一下这个文件')
  })
})

describe('建会话失败必须回可见原因', () => {
  test('Given 建会话抛错 When 收到普通消息 Then 回一条带原因的提示且不写入 binding', async () => {
    const { handler, sent } = createHandler()
    failSessionCreation = new Error('项目目录不存在，且不会被自动创建: /gone/project')

    await handler.handleIncomingMessage('fail-1', '你好')

    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('无法创建 Agent 会话')
    expect(sent[0]).toContain('/gone/project')
    expect(handler.getBinding('fail-1')).toBeUndefined()
    expect(headlessCalls).toHaveLength(0)
  })

  test('Given 建会话抛错 When /new Then 同样回提示', async () => {
    const { handler, sent } = createHandler()
    failSessionCreation = new Error('EACCES: permission denied')

    await handler.handleIncomingMessage('fail-2', '/new 新会话')

    expect(sent.at(-1)).toContain('无法创建 Agent 会话')
    expect(handler.getBinding('fail-2')).toBeUndefined()
  })
})
