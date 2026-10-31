import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRuntime, AgentSessionMeta, ChannelsConfig, FeishuBotConfig, FeishuChatBinding } from '@profer/shared'

// ===== 渠道配置夹具（真实 channel-manager 读取） =====
const configDir = mkdtempSync(join(tmpdir(), 'profer-feishu-bridge-runtime-'))
const channelsPath = join(configDir, 'channels.json')
const originalConfigDir = process.env.PROFER_CONFIG_DIR

// 绑定文件路径由 config-paths 根据 PROFER_CONFIG_DIR 推导，测试里直接复用
const { getFeishuBotBindingsPath } = await import('./config-paths')

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
      channels: [channel('pi-only', ['pi']), channel('claude-only', ['claude'])],
    }, null, 2),
    'utf-8',
  )
}

// ===== 设置夹具 =====
let settings: { agentRuntime: AgentRuntime; agentChannelId?: string; agentModelId?: string; agentWorkspaceId?: string } = {
  agentRuntime: 'pi',
  agentChannelId: 'pi-only',
}

// ===== 会话夹具 =====
const createdSessionCalls: Array<{ channelId?: string; modelId?: string; agentRuntime?: AgentRuntime }> = []
const sessionMetas = new Map<string, AgentSessionMeta>()
let sessionSeq = 0

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

mock.module('./settings-service', () => ({
  getSettings: () => settings,
}))

mock.module('./agent-session-manager', () => ({
  createAgentSession: (
    title?: string,
    channelId?: string,
    _workspaceId?: string,
    modelId?: string,
    agentRuntime?: AgentRuntime,
  ) => {
    createdSessionCalls.push({ channelId, modelId, agentRuntime })
    const id = `feishu-session-${++sessionSeq}`
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

const headlessInputs: Array<{ userMessage: string; rawUserMessage?: string; titleSourceText?: string }> = []

mock.module('./agent-service', () => ({
  agentEventBus: { on: () => () => {} },
  runAgentHeadless: async (input: { userMessage: string; rawUserMessage?: string; titleSourceText?: string }) => {
    headlessInputs.push(input)
  },
  stopAgent: () => {},
  isAgentSessionActive: () => false,
}))

mock.module('./agent-workspace-manager', () => ({
  listAgentWorkspacesByUpdatedAt: () => [{ id: 'ws-1', slug: 'default', name: '默认工作区' }],
  getAgentWorkspace: () => ({ id: 'ws-1', slug: 'default', name: '默认工作区' }),
  getWorkspaceCapabilities: () => ({ mcpServers: [], skills: [] }),
}))

const { FeishuBridge } = await import('./feishu-bridge')

const botConfig: FeishuBotConfig = {
  id: 'bot-1',
  name: '测试 Bot',
  enabled: true,
  appId: 'cli_test',
  appSecret: 'secret',
  defaultWorkspaceId: 'ws-1',
}

interface BridgeInternals {
  commandHandler: {
    ensureBinding(
      chatId: string,
      ctx: { chatId: string; senderOpenId: string; chatType: 'p2p' | 'group' },
    ): unknown
  }
  loadBindings(): void
}

function createBridge(): InstanceType<typeof FeishuBridge> {
  return new FeishuBridge({ ...botConfig })
}

beforeEach(() => {
  process.env.PROFER_CONFIG_DIR = configDir
  writeChannels()
  settings = { agentRuntime: 'pi', agentChannelId: 'pi-only' }
  createdSessionCalls.length = 0
  headlessInputs.length = 0
  sessionMetas.clear()
  sessionSeq = 0
  rmSync(getFeishuBotBindingsPath(botConfig.id), { force: true })
})

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe('飞书 Bot 建会话使用全局 Agent 内核', () => {
  test('Given 全局内核 Pi 且默认渠道 Pi-only When 建会话 Then 传 pi 并写入 binding', async () => {
    const bridge = createBridge()

    ;(bridge as unknown as BridgeInternals).commandHandler.ensureBinding('oc_1', {
      chatId: 'oc_1',
      senderOpenId: 'ou_1',
      chatType: 'p2p',
    })

    expect(createdSessionCalls[0]?.agentRuntime).toBe('pi')
    expect(createdSessionCalls[0]?.channelId).toBe('pi-only')
    expect(bridge.listBindings()[0]?.agentRuntime).toBe('pi')

    // 持久化里也要带上 runtime，供重启后恢复
    const persisted = JSON.parse(readFileSync(getFeishuBotBindingsPath(botConfig.id), 'utf-8')) as FeishuChatBinding[]
    expect(persisted[0]?.agentRuntime).toBe('pi')
  })

  test('Given Bot 默认渠道只勾选 Claude 而全局内核是 Pi When 建会话 Then 回退到 Pi 可用渠道', async () => {
    const bridge = new FeishuBridge({ ...botConfig, defaultChannelId: 'claude-only' })

    ;(bridge as unknown as BridgeInternals).commandHandler.ensureBinding('oc_2', {
      chatId: 'oc_2',
      senderOpenId: 'ou_1',
      chatType: 'p2p',
    })

    expect(createdSessionCalls[0]?.channelId).toBe('pi-only')
    expect(createdSessionCalls[0]?.agentRuntime).toBe('pi')
    // 回退后必须按新渠道重新解析模型，不能把 undefined 交给 orchestrator。
    expect(createdSessionCalls[0]?.modelId).toBe('pi-only-model')
    expect(bridge.listBindings()[0]?.channelId).toBe('pi-only')
  })

  test('Given 旧持久化 binding 无 agentRuntime When 加载 Then 从会话元数据回填', () => {
    const session = seedSession({ id: 'legacy-session', agentRuntime: 'pi', channelId: 'pi-only' })
    const legacyBinding = {
      chatId: 'oc_legacy',
      botId: botConfig.id,
      userId: 'ou_1',
      sessionId: session.id,
      workspaceId: 'ws-1',
      channelId: 'pi-only',
      createdAt: 1,
    }
    writeFileSync(getFeishuBotBindingsPath(botConfig.id), JSON.stringify([legacyBinding], null, 2), 'utf-8')

    const bridge = createBridge()
    ;(bridge as unknown as BridgeInternals).loadBindings()

    expect(bridge.listBindings()[0]?.agentRuntime).toBe('pi')
  })
})


describe('飞书消息进桌面端的展示文本', () => {
  test('userMessage 带 bridge 工程块，rawUserMessage 只保留用户原文', async () => {
    const bridge = createBridge()
    ;(bridge as unknown as Record<string, unknown>).sendMessage = async () => {}
    ;(bridge as unknown as Record<string, unknown>).sendCardMessage = async () => {}

    await (bridge as unknown as {
      handleUserMessage(
        ctx: { chatId: string; senderOpenId: string; chatType: 'p2p' | 'group'; messageId: string },
        text: string,
      ): Promise<void>
    }).handleUserMessage(
      { chatId: 'oc_display', senderOpenId: 'ou_1', chatType: 'p2p', messageId: 'm1' },
      '帮我看下这个报错',
    )

    const input = headlessInputs.at(-1)
    expect(input?.userMessage).toContain('<bridge_context>')
    expect(input?.rawUserMessage).toBe('帮我看下这个报错')
    expect(input?.titleSourceText).toBe('帮我看下这个报错')
  })
})
