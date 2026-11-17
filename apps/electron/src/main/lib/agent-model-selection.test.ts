import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChannelsConfig } from '@profer/shared'
import {
  assertEnabledModelForChannel,
  listEnabledAgentModelsForChannel,
} from './agent-model-selection'

const configDir = mkdtempSync(join(tmpdir(), 'profer-agent-model-selection-'))
const channelsPath = join(configDir, 'channels.json')
const originalConfigDir = process.env.PROFER_CONFIG_DIR

function writeChannels(agentRuntimes: Array<'pi' | 'claude'> = ['pi']): void {
  const config: ChannelsConfig = {
    version: 1,
    channels: [{
      id: 'pi-only-channel',
      name: 'Pi only',
      provider: 'custom',
      baseUrl: 'https://example.com/v1',
      agentBaseUrl: 'https://example.com/v1',
      apiKey: 'test-secret',
      models: [
        { id: 'enabled-model', name: 'Enabled model', enabled: true },
        { id: 'disabled-model', name: 'Disabled model', enabled: false },
      ],
      enabled: true,
      agentRuntimes,
      createdAt: 1,
      updatedAt: 1,
    }],
  }
  writeFileSync(channelsPath, JSON.stringify(config, null, 2), 'utf-8')
}

beforeEach(() => {
  process.env.PROFER_CONFIG_DIR = configDir
  writeChannels()
})

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe('Agent 模型渠道校验', () => {
  test('Given 渠道只开放 Pi When 校验 Pi 模型 Then 允许使用', () => {
    expect(assertEnabledModelForChannel({
      channelId: 'pi-only-channel',
      modelId: 'enabled-model',
      runtime: 'pi',
      purpose: '测试 Pi 分叉',
    })).toBe('enabled-model')
  })

  test('Given 渠道只开放 Pi When 按 Claude 校验同一模型 Then 拒绝', () => {
    expect(() => assertEnabledModelForChannel({
      channelId: 'pi-only-channel',
      modelId: 'enabled-model',
      runtime: 'claude',
      purpose: '测试 Claude 委派',
    })).toThrow('未开放 Agent')
  })

  test('Given 未传 runtime When 校验模型 Then 按产品默认内核（Pi）校验', () => {
    expect(assertEnabledModelForChannel({
      channelId: 'pi-only-channel',
      modelId: 'enabled-model',
      purpose: '测试旧调用方',
    })).toBe('enabled-model')
  })

  test('Given 渠道只开放 Pi When 列出 Pi 模型 Then 仅返回启用模型', () => {
    expect(listEnabledAgentModelsForChannel('pi-only-channel', '测试 Pi 模型', 'pi')).toMatchObject({
      channelId: 'pi-only-channel',
      models: [{ id: 'enabled-model', name: 'Enabled model' }],
    })
  })

  test('Given 模型已停用 When 按 Pi 校验 Then 拒绝该模型', () => {
    expect(() => assertEnabledModelForChannel({
      channelId: 'pi-only-channel',
      modelId: 'disabled-model',
      runtime: 'pi',
      purpose: '测试 Pi 分叉',
    })).toThrow('模型不属于当前渠道或未启用')
  })

  test('Given 渠道同时开放 Pi 与 Claude When 按 Claude 校验 Then 允许使用', () => {
    writeChannels(['pi', 'claude'])
    expect(assertEnabledModelForChannel({
      channelId: 'pi-only-channel',
      modelId: 'enabled-model',
      runtime: 'claude',
      purpose: '测试 Claude 委派',
    })).toBe('enabled-model')
  })
})
