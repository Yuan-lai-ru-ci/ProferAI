/**
 * listChannels 不再替用户假设供应商。
 *
 * 历史行为：首次列出渠道时，只要没有 DeepSeek 渠道就自动创建一个占位渠道，
 * 并预置 deepseek-v4-pro / deepseek-v4-flash。用户若不用 DeepSeek，会看到一个
 * 从未配置过的渠道；而预置清单又冒充了真实端点能力。这里锁定「渠道只来自
 * 用户自配或服务端下发」的行为。
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChannelsConfig } from '@profer/shared'
import { listChannels } from './channel-manager'
import { mergeServerChannelModels } from './channel-url-routing'

const configDir = mkdtempSync(join(tmpdir(), 'profer-channels-'))
const channelsPath = join(configDir, 'channels.json')

beforeEach(() => {
  // 配置根在每次调用时解析，因此可在测试内隔离，避免触碰真实用户目录。
  process.env.PROFER_CONFIG_DIR = configDir
  rmSync(channelsPath, { force: true })
})

afterAll(() => {
  delete process.env.PROFER_CONFIG_DIR
  rmSync(configDir, { recursive: true, force: true })
})

describe('listChannels 占位渠道', () => {
  test('Given 用户从未配置任何渠道 When 列出渠道 Then 返回空列表且不生成 DeepSeek 占位渠道', () => {
    expect(listChannels()).toEqual([])
  })

  test('Given 用户只自配了 Kimi 渠道 When 列出渠道 Then 原样返回且不追加其它供应商', () => {
    const config: ChannelsConfig = {
      version: 1,
      channels: [
        {
          id: 'user-kimi',
          name: 'Kimi API',
          provider: 'kimi-api',
          baseUrl: 'https://api.moonshot.cn/anthropic',
          apiKey: 'encrypted',
          models: [{ id: 'k3', name: 'Kimi K3', enabled: true }],
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }
    writeFileSync(channelsPath, JSON.stringify(config, null, 2), 'utf-8')

    const channels = listChannels()

    expect(channels.map((channel) => channel.id)).toEqual(['user-kimi'])
    expect(channels.some((channel) => channel.provider === 'deepseek')).toBe(false)
  })
})

describe('服务端渠道同步时的本地状态保留', () => {
  test('Given 用户在代管渠道上勾选过 1M When 服务端下发新模型列表 Then 保留勾选与启停状态', () => {
    const merged = mergeServerChannelModels(
      [
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', enabled: true },
      ],
      [
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: false, context1m: false },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', enabled: true, context1m: true },
      ],
    )

    expect(merged).toEqual([
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: false, context1m: false },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', enabled: true, context1m: true },
    ])
  })

  test('Given 本地从未设置过 When 服务端下发新模型 Then 保持服务端默认且不带 1M 覆盖', () => {
    const merged = mergeServerChannelModels(
      [{ id: 'glm-5.3', name: 'GLM-5.3', enabled: true }],
      undefined,
    )

    expect(merged).toEqual([{ id: 'glm-5.3', name: 'GLM-5.3', enabled: true }])
    expect('context1m' in merged[0]!).toBe(false)
  })
})
