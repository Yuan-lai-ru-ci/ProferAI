import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRuntime, AgentSessionMeta, ChannelsConfig } from '@profer/shared'

/**
 * 钉钉 / 微信聊天绑定持久化测试
 *
 * 目标：绑定变更后落盘、重启后能恢复、解除绑定后从文件里消失。
 */

const configDir = mkdtempSync(join(tmpdir(), 'profer-im-bindings-'))
const channelsPath = join(configDir, 'channels.json')
const originalConfigDir = process.env.PROFER_CONFIG_DIR

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

mock.module('./settings-service', () => ({ getSettings: () => settings }))

mock.module('./agent-session-manager', () => ({
  createAgentSession: (
    title?: string,
    channelId?: string,
    _workspaceId?: string,
    _modelId?: string,
    agentRuntime?: AgentRuntime,
  ) => seedSession({ id: `persist-${++sessionSeq}`, title: title ?? '新会话', channelId, agentRuntime: agentRuntime ?? 'pi', agentRuntimeLocked: false }),
  listAgentSessions: () => Array.from(sessionMetas.values()),
  getAgentSessionMeta: (id: string) => sessionMetas.get(id),
}))

mock.module('./agent-service', () => ({
  agentEventBus: { on: () => () => {} },
  runAgentHeadless: async () => {},
  stopAgent: () => {},
  isAgentSessionActive: () => false,
}))

mock.module('./agent-workspace-manager', () => ({
  listAgentWorkspacesByUpdatedAt: () => [{ id: 'ws-1', slug: 'default', name: '默认工作区' }],
  getAgentWorkspace: (id: string) => id === 'ws-1' ? ({ id: 'ws-1', slug: 'default', name: '默认工作区' }) : undefined,
  getWorkspaceCapabilities: () => ({ mcpServers: [], skills: [] }),
}))

const { getDingTalkBotBindingsPath, getWeChatBindingsPath } = await import('./config-paths')
const { DingTalkBridge } = await import('./dingtalk-bridge')
const { wechatBridge } = await import('./wechat-bridge')

const dingtalkBot = {
  id: 'bot-persist',
  name: '测试钉钉',
  enabled: true,
  clientId: 'cid',
  clientSecret: '',
}

beforeEach(() => {
  process.env.PROFER_CONFIG_DIR = configDir
  writeChannels()
  settings = { agentRuntime: 'pi', agentChannelId: 'pi-only' }
  sessionMetas.clear()
  sessionSeq = 0
  rmSync(getDingTalkBotBindingsPath(dingtalkBot.id), { force: true })
  rmSync(getWeChatBindingsPath(), { force: true })
})

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe('钉钉绑定持久化', () => {
  test('更新绑定拒绝不存在的工作区/会话及已被其他聊天占用的会话', () => {
    const bridge = new DingTalkBridge(dingtalkBot)
    const internals = bridge as unknown as {
      commandHandler: { ensureBinding(chatId: string): unknown }
      updateBinding(chatId: string, input: { workspaceId?: string; sessionId?: string }): unknown
    }
    internals.commandHandler.ensureBinding('ding-owner')
    internals.commandHandler.ensureBinding('ding-other')
    const owner = bridge.listBindings().find((binding) => binding.chatId === 'ding-owner')!

    expect(internals.updateBinding('ding-owner', { workspaceId: 'missing-workspace' })).toBeNull()
    expect(internals.updateBinding('ding-owner', { sessionId: 'missing-session' })).toBeNull()
    expect(internals.updateBinding('ding-owner', { sessionId: bridge.listBindings().find((b) => b.chatId === 'ding-other')!.sessionId })).toBeNull()
    expect(bridge.listBindings().find((binding) => binding.chatId === 'ding-owner')?.sessionId).toBe(owner.sessionId)
  })

  test('建会话后写入文件，新实例可恢复', () => {
    const bridge = new DingTalkBridge(dingtalkBot)
    ;(bridge as unknown as { commandHandler: { ensureBinding(chatId: string): unknown } })
      .commandHandler.ensureBinding('ding-chat-1')

    const path = getDingTalkBotBindingsPath(dingtalkBot.id)
    expect(existsSync(path)).toBe(true)
    const saved = JSON.parse(readFileSync(path, 'utf-8')) as Array<{ chatId: string }>
    expect(saved.map((item) => item.chatId)).toContain('ding-chat-1')

    const restored = new DingTalkBridge(dingtalkBot)
    ;(restored as unknown as { loadBindings(): void }).loadBindings()
    expect(restored.listBindings().map((item) => item.chatId)).toContain('ding-chat-1')
  })

  test('解除绑定后从文件和内存中移除', () => {
    const bridge = new DingTalkBridge(dingtalkBot)
    ;(bridge as unknown as { commandHandler: { ensureBinding(chatId: string): unknown } })
      .commandHandler.ensureBinding('ding-chat-2')

    expect(bridge.removeBinding('ding-chat-2')).toBe(true)
    expect(bridge.listBindings()).toHaveLength(0)
    const saved = JSON.parse(readFileSync(getDingTalkBotBindingsPath(dingtalkBot.id), 'utf-8')) as unknown[]
    expect(saved).toHaveLength(0)
  })
})

describe('微信绑定持久化', () => {
  test('更新绑定拒绝不存在的工作区/会话及已被其他聊天占用的会话', () => {
    const internals = wechatBridge as unknown as {
      commandHandler: { ensureBinding(chatId: string): unknown }
      updateBinding(chatId: string, input: { workspaceId?: string; sessionId?: string }): unknown
    }
    internals.commandHandler.ensureBinding('wx-owner')
    internals.commandHandler.ensureBinding('wx-other')
    const owner = wechatBridge.listBindings().find((binding) => binding.chatId === 'wx-owner')!
    const otherSessionId = wechatBridge.listBindings().find((binding) => binding.chatId === 'wx-other')!.sessionId

    expect(internals.updateBinding('wx-owner', { workspaceId: 'missing-workspace' })).toBeNull()
    expect(internals.updateBinding('wx-owner', { sessionId: 'missing-session' })).toBeNull()
    expect(internals.updateBinding('wx-owner', { sessionId: otherSessionId })).toBeNull()
    expect(wechatBridge.listBindings().find((binding) => binding.chatId === 'wx-owner')?.sessionId).toBe(owner.sessionId)
  })

  test('建会话后写入文件，清空内存后可恢复', () => {
    const internals = wechatBridge as unknown as {
      commandHandler: { ensureBinding(chatId: string): unknown }
      chatBindings: Map<string, unknown>
      sessionToChat: Map<string, string>
      loadBindings(): void
    }

    internals.commandHandler.ensureBinding('wx-chat-1')

    const path = getWeChatBindingsPath()
    expect(existsSync(path)).toBe(true)
    const saved = JSON.parse(readFileSync(path, 'utf-8')) as Array<{ chatId: string }>
    expect(saved.map((item) => item.chatId)).toContain('wx-chat-1')

    internals.chatBindings.clear()
    internals.sessionToChat.clear()
    internals.loadBindings()
    expect(wechatBridge.listBindings().map((item) => item.chatId)).toContain('wx-chat-1')
  })
})
