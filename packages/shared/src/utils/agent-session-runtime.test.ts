import { describe, expect, test } from 'bun:test'
import { canSelectAgentSessionRuntime, resolveAgentRuntimeChannelConflict } from './agent-session-runtime'

describe('会话内核绑定策略', () => {
  test('旧会话缺省字段和未加载会话保持锁定，不跟随全局默认', () => {
    expect(canSelectAgentSessionRuntime(undefined)).toBe(false)
    expect(canSelectAgentSessionRuntime({})).toBe(false)
    expect(canSelectAgentSessionRuntime({ draft: false })).toBe(false)
  })

  test('新空会话与历史空草稿允许选择，明确锁定优先于草稿', () => {
    expect(canSelectAgentSessionRuntime({ agentRuntimeLocked: false })).toBe(true)
    expect(canSelectAgentSessionRuntime({ draft: true })).toBe(true)
    expect(canSelectAgentSessionRuntime({ draft: true, agentRuntimeLocked: true })).toBe(false)
  })

  test('原生恢复和分叉资产不能因草稿或未锁标记而换内核', () => {
    for (const assets of [
      { sdkSessionId: 'native' }, { piSessionFile: '/pi/session.jsonl' },
      { piEntryBindings: { message: 'entry' } }, { piFileCheckpoints: { entry: '/checkpoint' } },
      { forkSourceSdkSessionId: 'source' }, { forkSourceDir: '/source' },
      { resumeAtMessageUuid: 'resume' }, { parentSessionId: 'parent' },
      { explorationParentSessionId: 'source' }, { sourceAutomationId: 'automation' },
    ]) {
      expect(canSelectAgentSessionRuntime({ draft: true, agentRuntimeLocked: false, ...assets })).toBe(false)
    }
    expect(canSelectAgentSessionRuntime({ draft: true, piEntryBindings: {}, piFileCheckpoints: {} })).toBe(true)
  })
})

describe('会话内核与渠道一致性', () => {
  const piChannel = { name: 'DeepSeek', provider: 'deepseek' as const, enabled: true, agentRuntimes: ['pi' as const] }
  const claudeChannel = { name: '官方 Anthropic', provider: 'anthropic' as const, enabled: true, agentRuntimes: ['claude' as const] }
  const bothChannel = { name: '双内核', provider: 'zhipu' as const, enabled: true, agentRuntimes: ['pi' as const, 'claude' as const] }

  test('渠道为该内核开启时放行', () => {
    expect(resolveAgentRuntimeChannelConflict({ sessionRuntime: 'pi', channel: piChannel, channelId: 'c1' })).toBeNull()
    expect(resolveAgentRuntimeChannelConflict({ sessionRuntime: 'pi', channel: bothChannel, channelId: 'c1' })).toBeNull()
    expect(resolveAgentRuntimeChannelConflict({ sessionRuntime: 'claude', channel: bothChannel, channelId: 'c1' })).toBeNull()
  })

  test('跨内核拒绝，并给出「新建会话」这条唯一出路', () => {
    const message = resolveAgentRuntimeChannelConflict({ sessionRuntime: 'pi', channel: claudeChannel, channelId: 'c1' })
    expect(message).toContain('Pi 引擎')
    expect(message).toContain('Claude 引擎')
    expect(message).toContain('新建会话')
    expect(message).toContain('官方 Anthropic')
    // 内部词不能出现在用户文案里。
    for (const internal of ['runtime', 'artifact', 'Pi 文件', 'transcript', 'SDK']) {
      expect(message).not.toContain(internal)
    }
    expect(resolveAgentRuntimeChannelConflict({ sessionRuntime: 'claude', channel: piChannel, channelId: 'c1' }))
      .toContain('Claude 引擎')
  })

  test('只判内核：未指定渠道、渠道已不存在或已停用都不在这里拒绝', () => {
    // 渠道缺失/停用属于另一类失败（旧链 channel_not_found preflight、新链凭据解析），
    // 在这里判死会误伤拿不到渠道注册表的宿主（隔离测试、标题生成、渠道刚被删除）。
    expect(resolveAgentRuntimeChannelConflict({ sessionRuntime: 'pi', channel: claudeChannel })).toBeNull()
    expect(resolveAgentRuntimeChannelConflict({ sessionRuntime: 'pi', channel: undefined, channelId: 'gone' })).toBeNull()
    expect(resolveAgentRuntimeChannelConflict({ sessionRuntime: 'pi', channel: { ...claudeChannel, enabled: false }, channelId: 'c1' }))
      .toBeNull()
    const neither = { name: '', provider: 'deepseek' as const, enabled: true, agentRuntimes: [] }
    expect(resolveAgentRuntimeChannelConflict({ sessionRuntime: 'pi', channel: neither, channelId: 'c1' }))
      .toContain('没有开启 Agent 对话')
  })

  test('缺 agentRuntimes 的老渠道按 provider 推导，行为与既有判定一致', () => {
    const legacyPi = { name: '旧 DeepSeek', provider: 'deepseek' as const, enabled: true }
    const legacyAnthropic = { name: '旧 Anthropic', provider: 'anthropic' as const, enabled: true }
    expect(resolveAgentRuntimeChannelConflict({ sessionRuntime: 'pi', channel: legacyPi, channelId: 'c1' })).toBeNull()
    expect(resolveAgentRuntimeChannelConflict({ sessionRuntime: 'claude', channel: legacyAnthropic, channelId: 'c1' })).toBeNull()
  })
})
