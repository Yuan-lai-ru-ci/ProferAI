import { describe, expect, test } from 'bun:test'
import type { Channel } from '@profer/shared'
import { inferAgentRuntimeModes, isAgentEnabledForChannel, isChannelEnabledForRuntime } from '@profer/shared'
import {
  getChannelProtocol,
  getOfficialChannelDisplayName,
  isModelFamilyChannel,
  resolvePiCoreState,
  supportsChannelProtocol,
} from './channel-model-groups'

function ch(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'ch-1',
    name: '自配渠道',
    provider: 'custom',
    baseUrl: 'https://gateway.example.com/v1',
    apiKey: '',
    models: [],
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function pool(overrides: Partial<Channel> = {}): Pick<Channel, 'id' | 'name' | 'managedType'> {
  return { id: 'newapi-family-gpt', name: 'GPT', managedType: 'model-family', ...overrides }
}

describe('渠道的 Agent 内核勾选', () => {
  // 迁移必须与升级前行为等价，否则老用户会静默丢能力。
  test('Given 老配置没有勾选字段 When 推导内核 Then 与迁移前的门禁等价', () => {
    expect(inferAgentRuntimeModes({ provider: 'deepseek' })).toEqual(['pi', 'claude'])
    expect(inferAgentRuntimeModes({ provider: 'anthropic' })).toEqual(['pi', 'claude'])
    expect(inferAgentRuntimeModes({ provider: 'anthropic-compatible' })).toEqual(['pi', 'claude'])
    expect(inferAgentRuntimeModes({ provider: 'ollama' })).toEqual(['pi', 'claude'])
    // 非白名单类型历史上只能用 Pi
    expect(inferAgentRuntimeModes({ provider: 'custom' })).toEqual(['pi'])
    expect(inferAgentRuntimeModes({ provider: 'zhipu' })).toEqual(['pi'])
    // xAI 没有 Anthropic 端点，编排层也拒绝 xAI + Claude；Pi 需要实验开关
    expect(inferAgentRuntimeModes({ provider: 'xai' })).toEqual([])
    expect(inferAgentRuntimeModes({ provider: 'xai', agentExperimentalEnabled: true })).toEqual(['pi'])
  })

  test('Given 用户勾选内核 When 判定可用性 Then 以勾选为准而不是渠道类型', () => {
    const both = ch({ provider: 'custom', agentRuntimes: ['pi', 'claude'] })
    expect(isChannelEnabledForRuntime(both, 'pi')).toBe(true)
    // 关键回归：custom 勾了 claude 就能用于 Claude，不再被类型门禁拦住
    expect(isChannelEnabledForRuntime(both, 'claude')).toBe(true)

    const onlyPi = ch({ provider: 'custom', agentRuntimes: ['pi'] })
    expect(isChannelEnabledForRuntime(onlyPi, 'pi')).toBe(true)
    expect(isChannelEnabledForRuntime(onlyPi, 'claude')).toBe(false)

    // 反向：Anthropic 类型也可以只勾 Pi
    const anthropicOnlyPi = ch({ provider: 'anthropic', agentRuntimes: ['pi'] })
    expect(isChannelEnabledForRuntime(anthropicOnlyPi, 'claude')).toBe(false)
  })

  test('Given 渠道未启用 When 判定 Then 两个内核都不可用', () => {
    const disabled = ch({ provider: 'deepseek', enabled: false, agentRuntimes: ['pi', 'claude'] })
    expect(isChannelEnabledForRuntime(disabled, 'pi')).toBe(false)
    expect(isChannelEnabledForRuntime(disabled, 'claude')).toBe(false)
  })

  test('Given 老配置无勾选字段 When 判定 Then 回退到 provider 推导', () => {
    expect(isChannelEnabledForRuntime(ch({ provider: 'custom' }), 'claude')).toBe(false)
    expect(isChannelEnabledForRuntime(ch({ provider: 'custom' }), 'pi')).toBe(true)
    expect(isChannelEnabledForRuntime(ch({ provider: 'deepseek' }), 'claude')).toBe(true)
  })
})

describe('运行时的渠道协议过滤', () => {
  test('Given 勾选了 Claude 的 custom 渠道 When 按 anthropic 过滤 Then 放行', () => {
    expect(supportsChannelProtocol(ch({ provider: 'custom', agentRuntimes: ['pi', 'claude'] }), 'anthropic')).toBe(true)
    expect(supportsChannelProtocol(ch({ provider: 'custom', agentRuntimes: ['pi', 'claude'] }), 'openai')).toBe(true)
  })

  test('Given 只勾了 Pi When 按 anthropic 过滤 Then 拦截', () => {
    expect(supportsChannelProtocol(ch({ provider: 'custom', agentRuntimes: ['pi'] }), 'anthropic')).toBe(false)
  })

  test('Given 老配置 When 过滤 Then 行为与迁移前一致', () => {
    expect(supportsChannelProtocol(ch({ provider: 'deepseek' }), 'anthropic')).toBe(true)
    expect(supportsChannelProtocol(ch({ provider: 'deepseek' }), 'openai')).toBe(true)
    expect(supportsChannelProtocol(ch({ provider: 'ollama' }), 'anthropic')).toBe(true)
    expect(supportsChannelProtocol(ch({ provider: 'custom' }), 'anthropic')).toBe(false)
    expect(supportsChannelProtocol(ch({ provider: 'zhipu' }), 'openai')).toBe(true)
    expect(supportsChannelProtocol(ch({ provider: 'zhipu' }), 'anthropic')).toBe(false)
  })

  test('Given 未启用渠道 When 过滤 Then 一律拦截', () => {
    expect(supportsChannelProtocol(ch({ provider: 'deepseek', enabled: false }), 'anthropic')).toBe(false)
  })
})

describe('getChannelProtocol 展示值', () => {
  test('保持单一展示值，不随勾选变化', () => {
    expect(getChannelProtocol('deepseek')).toBe('openai')
    expect(getChannelProtocol('anthropic-compatible')).toBe('anthropic')
    expect(getChannelProtocol('ollama')).toBe('openai')
  })
})

describe('官方模型池展示元数据', () => {
  test('Given 服务端标记 model-family When 渲染名称 Then 显示模型池而不是物理渠道', () => {
    const value = pool({})
    expect(isModelFamilyChannel(value)).toBe(true)
    expect(getOfficialChannelDisplayName(value)).toBe('GPT 模型池')
  })

  test('Given 旧版官方渠道 When 渲染名称 Then 保持兼容的官方渠道名称', () => {
    const value = pool({ id: 'newapi-8', name: 'GPT', managedType: 'legacy' })
    expect(isModelFamilyChannel(value)).toBe(false)
    expect(getOfficialChannelDisplayName(value)).toBe('GPT')
  })

  test('Given 服务端未返回 managedType 但使用稳定模型池 ID When 判断 Then 仍识别为模型池', () => {
    const value = pool({ id: 'newapi-family-claude', name: 'Claude', managedType: undefined })
    expect(isModelFamilyChannel(value)).toBe(true)
    expect(getOfficialChannelDisplayName(value)).toBe('Claude 模型池')
  })
})

describe('渠道列表的 Pi 内核标签', () => {
  test('Given xAI 渠道已开启实验开关并勾选 Pi 内核 When 判定标签状态 Then 显示为已启用的实验内核', () => {
    expect(resolvePiCoreState({
      provider: 'xai',
      enabled: true,
      agentExperimentalEnabled: true,
      agentRuntimes: ['pi'],
    })).toBe('experimental-active')
  })

  test('Given xAI 渠道未开实验开关或停用 When 判定标签状态 Then 显示未启用', () => {
    expect(resolvePiCoreState({
      provider: 'xai',
      enabled: true,
      agentExperimentalEnabled: false,
      agentRuntimes: undefined,
    })).toBe('experimental-inactive')
    expect(resolvePiCoreState({
      provider: 'xai',
      enabled: false,
      agentExperimentalEnabled: true,
      agentRuntimes: ['pi'],
    })).toBe('experimental-inactive')
  })

  test('Given 非 xAI 渠道 When 判定标签状态 Then 一律为普通 Pi 内核', () => {
    expect(resolvePiCoreState({
      provider: 'deepseek',
      enabled: true,
      agentExperimentalEnabled: false,
      agentRuntimes: ['pi'],
    })).toBe('active')
  })

  test('回归：旧判据对 xAI 恒为 false，标签不得再用它判定', () => {
    // 根因锁：isAgentEnabledForChannel 是「是否勾选 Claude 内核」的 @deprecated 别名，
    // 而 xAI 按设计永远不获得 claude 内核 → 用它会让已开启实验的渠道显示「Pi 实验未启用」。
    const xai = {
      provider: 'xai' as const,
      enabled: true,
      agentExperimentalEnabled: true,
      agentRuntimes: ['pi'] as Array<'pi' | 'claude'>,
    }
    expect(isAgentEnabledForChannel(xai)).toBe(false)
    expect(resolvePiCoreState(xai)).toBe('experimental-active')
  })
})
