import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRuntime, AgentSessionMeta, ChannelsConfig, FeishuBotConfig } from '@profer/shared'

/**
 * 飞书命令级回归测试（P1 迁移前的行为基线）
 *
 * 只断言"用户可见结果"：发出去的是卡片还是文本、绑定是否落盘、配置是否写回。
 * 不依赖飞书 SDK：sendMessage / sendCardMessage 在实例上被替换为记录器。
 */

const configDir = mkdtempSync(join(tmpdir(), 'profer-feishu-commands-'))
const channelsPath = join(configDir, 'channels.json')
const originalConfigDir = process.env.PROFER_CONFIG_DIR

const { getFeishuBotBindingsPath, getFeishuConfigPath } = await import('./config-paths')

function channel(id: string, agentRuntimes: Array<'pi' | 'claude'>): ChannelsConfig['channels'][number] {
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
    JSON.stringify({ version: 1, channels: [channel('pi-only', ['pi'])] }, null, 2),
    'utf-8',
  )
}

let settings: { agentRuntime: AgentRuntime; agentChannelId?: string; agentModelId?: string; agentWorkspaceId?: string } = {
  agentRuntime: 'pi',
  agentChannelId: 'pi-only',
}

const createdSessionCalls: Array<{ title?: string; channelId?: string; modelId?: string; agentRuntime?: AgentRuntime }> = []
const sessionMetas = new Map<string, AgentSessionMeta>()
let sessionSeq = 0
let stopCalls = 0

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

mock.module('./settings-service', () => ({ getSettings: () => settings }))

mock.module('./agent-session-manager', () => ({
  createAgentSession: (
    title?: string,
    channelId?: string,
    _workspaceId?: string,
    modelId?: string,
    agentRuntime?: AgentRuntime,
  ) => {
    createdSessionCalls.push({ title, channelId, modelId, agentRuntime })
    const id = `cmd-session-${++sessionSeq}`
    return seedSession({ id, title: title ?? '新会话', channelId, agentRuntime: agentRuntime ?? 'claude', agentRuntimeLocked: false })
  },
  listAgentSessions: () => Array.from(sessionMetas.values()),
  getAgentSessionMeta: (id: string) => sessionMetas.get(id),
}))

mock.module('./agent-service', () => ({
  agentEventBus: { on: () => () => {} },
  runAgentHeadless: async () => {},
  stopAgent: () => { stopCalls += 1 },
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
}

interface SentItem { kind: 'text' | 'card'; payload: unknown }
interface BridgeInternals {
  handleCommand(ctx: { chatId: string; senderOpenId: string; chatType: 'p2p' | 'group' }, text: string): Promise<void>
}

function createBridge(config: Partial<FeishuBotConfig> = {}): { bridge: InstanceType<typeof FeishuBridge>; sent: SentItem[] } {
  const bridge = new FeishuBridge({ ...botConfig, ...config })
  const sent: SentItem[] = []
  ;(bridge as unknown as Record<string, unknown>).sendMessage = async (_chatId: string, text: string) => {
    sent.push({ kind: 'text', payload: text })
  }
  ;(bridge as unknown as Record<string, unknown>).sendCardMessage = async (_chatId: string, card: Record<string, unknown>) => {
    sent.push({ kind: 'card', payload: card })
  }
  return { bridge, sent }
}

function run(bridge: InstanceType<typeof FeishuBridge>, text: string): Promise<void> {
  return (bridge as unknown as BridgeInternals).handleCommand({ chatId: 'oc_1', senderOpenId: 'ou_1', chatType: 'p2p' }, text)
}

/** 预置飞书配置文件，供 /workspace 写回 bot 默认工作区 */
function seedFeishuConfig(config: Partial<FeishuBotConfig> = {}): void {
  writeFileSync(
    getFeishuConfigPath(),
    JSON.stringify({ version: 2, bots: [{ ...botConfig, appSecret: '', ...config }] }, null, 2),
    'utf-8',
  )
}

beforeEach(() => {
  process.env.PROFER_CONFIG_DIR = configDir
  writeChannels()
  seedFeishuConfig()
  settings = { agentRuntime: 'pi', agentChannelId: 'pi-only' }
  createdSessionCalls.length = 0
  sessionMetas.clear()
  sessionSeq = 0
  stopCalls = 0
  rmSync(getFeishuBotBindingsPath(botConfig.id), { force: true })
})

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe('飞书命令：用户可见行为基线', () => {
  test('/help 发卡片而不是纯文本', async () => {
    const { bridge, sent } = createBridge()
    await run(bridge, '/help')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.kind).toBe('card')
    expect(JSON.stringify(sent[0]!.payload)).toContain('Profer Bot 命令')
  })

  test('/new 在未设全局工作区时兜底到 default 工作区并落盘', async () => {
    settings = { agentRuntime: 'pi', agentChannelId: 'pi-only' }
    const { bridge } = createBridge()
    await run(bridge, '/new')

    const binding = bridge.listBindings()[0]
    expect(binding?.workspaceId).toBe('ws-1')
    const persisted = JSON.parse(readFileSync(getFeishuBotBindingsPath(botConfig.id), 'utf-8')) as Array<{ workspaceId: string }>
    expect(persisted[0]?.workspaceId).toBe('ws-1')
  })

  test('/new 带标题时把标题传给会话创建', async () => {
    const { bridge } = createBridge()
    await run(bridge, '/new 我的标题')
    expect(createdSessionCalls[0]?.title).toBe('我的标题')
  })

  test('/stop 调用 stopAgent 并回复文本', async () => {
    const { bridge, sent } = createBridge()
    await run(bridge, '/new')
    await run(bridge, '/stop')
    expect(stopCalls).toBe(1)
    expect(sent.at(-1)).toEqual({ kind: 'text', payload: '已停止 Agent' })
  })

  test('/workspace 1 写回 Bot 默认工作区', async () => {
    const { bridge } = createBridge()
    await run(bridge, '/workspace 1')
    const config = JSON.parse(readFileSync(getFeishuConfigPath(), 'utf-8')) as { bots: Array<{ defaultWorkspaceId?: string }> }
    expect(config.bots[0]?.defaultWorkspaceId).toBe('ws-1')
  })

  test('/now 发卡片且 MCP/Skills 空态显式写“无”', async () => {
    const { bridge, sent } = createBridge({ defaultWorkspaceId: 'ws-1' })
    await run(bridge, '/new')
    await run(bridge, '/now')
    const card = sent.at(-1)
    expect(card?.kind).toBe('card')
    expect(JSON.stringify(card?.payload)).toContain('**MCP Servers**: 无')
    expect(JSON.stringify(card?.payload)).toContain('**Skills**: 无')
  })

  test('/model 发卡片列出渠道', async () => {
    const { bridge, sent } = createBridge()
    await run(bridge, '/model')
    expect(sent.at(-1)?.kind).toBe('card')
    expect(JSON.stringify(sent.at(-1)?.payload)).toContain('pi-only')
  })
})
