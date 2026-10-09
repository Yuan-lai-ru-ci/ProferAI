import { describe, expect, test } from 'bun:test'
import type { ChannelModel, FetchModelsResult } from '@profer/shared'
import {
  applyModelDiscoveryResult,
  buildModelDiscoveryAttemptKey,
  shouldAutoDiscoverModels,
} from './channel-model-discovery'

function result(success: boolean, models: ChannelModel[] = []): FetchModelsResult {
  return {
    success,
    message: success ? '成功获取模型' : '服务器暂时不可达',
    models,
  }
}

describe('applyModelDiscoveryResult', () => {
  test('keeps every configured model when remote discovery fails', () => {
    const configured: ChannelModel[] = [
      { id: 'local-custom', name: '本地自配模型', enabled: true },
      { id: 'previously-fetched', name: '旧发现模型', enabled: false, source: 'fetched' },
      { id: 'manual-keep', name: '手动添加模型', enabled: true, source: 'manual' },
    ]

    expect(applyModelDiscoveryResult(configured, result(false))).toBe(configured)
  })

  test('updates discovered models only after a successful remote response', () => {
    const configured: ChannelModel[] = [
      { id: 'local-custom', name: '本地自配模型', enabled: true, source: 'manual' },
      { id: 'shared-model', name: '旧名称', enabled: true, source: 'fetched' },
      { id: 'stale-model', name: '旧发现模型', enabled: false, source: 'fetched' },
    ]
    const discovered: ChannelModel[] = [
      { id: 'shared-model', name: '新名称', enabled: true },
      { id: 'new-model', name: '新发现模型', enabled: true },
    ]

    expect(applyModelDiscoveryResult(configured, result(true, discovered))).toEqual([
      { id: 'local-custom', name: '本地自配模型', enabled: true, source: 'manual' },
      { id: 'shared-model', name: '新名称', enabled: true, source: 'fetched' },
      { id: 'new-model', name: '新发现模型', enabled: false, source: 'fetched' },
    ])
  })

  test('Given 用户给模型勾选过 1M When 重新从供应商拉取 Then 保留该勾选', () => {
    const configured: ChannelModel[] = [
      { id: 'keep-forced-on', name: '强开 1M', enabled: true, context1m: true, source: 'fetched' },
      { id: 'keep-forced-off', name: '强关 1M', enabled: true, context1m: false, source: 'fetched' },
    ]
    const discovered: ChannelModel[] = [
      { id: 'keep-forced-on', name: '强开 1M', enabled: true },
      { id: 'keep-forced-off', name: '强关 1M', enabled: true },
      { id: 'brand-new', name: '新模型', enabled: true },
    ]

    expect(applyModelDiscoveryResult(configured, result(true, discovered))).toEqual([
      { id: 'keep-forced-on', name: '强开 1M', enabled: true, context1m: true, source: 'fetched' },
      { id: 'keep-forced-off', name: '强关 1M', enabled: true, context1m: false, source: 'fetched' },
      { id: 'brand-new', name: '新模型', enabled: false, source: 'fetched' },
    ])
  })

  test('Given 手动模型与远端同 ID When 刷新 Then 保留手动来源和用户设置', () => {
    const configured: ChannelModel[] = [
      { id: 'manual-model', name: '我的别名', enabled: true, context1m: true, source: 'manual' },
      { id: 'stale-fetched', name: '旧发现', enabled: true, source: 'fetched' },
    ]
    const discovered: ChannelModel[] = [
      { id: 'manual-model', name: '供应商名称', enabled: false },
      { id: 'fresh-model', name: '新模型', enabled: true },
    ]

    expect(applyModelDiscoveryResult(configured, result(true, discovered))).toEqual([
      { id: 'manual-model', name: '我的别名', enabled: true, context1m: true, source: 'manual' },
      { id: 'fresh-model', name: '新模型', enabled: false, source: 'fetched' },
    ])
  })

  test('Given 历史未标记模型与手工模型 When 目录先同 ID 后为空 Then 两次刷新都保留本地配置', () => {
    const configured: ChannelModel[] = [
      { id: 'legacy', name: '历史别名', enabled: false, context1m: false },
      { id: 'manual', name: '手工别名', enabled: true, source: 'manual' },
    ]
    const refreshed = applyModelDiscoveryResult(configured, result(true, [
      { id: 'legacy', name: '远端别名', enabled: true },
      { id: 'manual', name: '远端别名', enabled: false },
    ]))
    expect(refreshed).toEqual(configured)
    expect(applyModelDiscoveryResult(refreshed, result(true))).toEqual(configured)
  })

  test('Given builtin catalog When refreshing with a reduced list Then remove stale catalog models and preserve source', () => {
    const configured: ChannelModel[] = [
      { id: 'removed', name: '已下线', enabled: true, source: 'builtin-catalog' },
      { id: 'kept', name: '旧名称', enabled: false, context1m: true, source: 'builtin-catalog' },
      { id: 'manual', name: '手动模型', enabled: true, source: 'manual' },
    ]

    expect(applyModelDiscoveryResult(configured, result(true, [
      { id: 'kept', name: '新名称', enabled: true },
      { id: 'new', name: '新模型', enabled: true },
    ]), 'builtin-catalog')).toEqual([
      { id: 'manual', name: '手动模型', enabled: true, source: 'manual' },
      { id: 'kept', name: '新名称', enabled: false, context1m: true, source: 'builtin-catalog' },
      { id: 'new', name: '新模型', enabled: false, source: 'builtin-catalog' },
    ])
  })
})

describe('buildModelDiscoveryAttemptKey', () => {
  test('Given 同一凭证与地址 When 只差首尾空白 Then 视为同一次尝试', () => {
    expect(buildModelDiscoveryAttemptKey({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com ', apiKey: ' sk-1 ' }))
      .toBe(buildModelDiscoveryAttemptKey({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-1' }))
  })

  test('Given 已尝试失败 When 换地址或换 Key Then 视为新的尝试', () => {
    const base = buildModelDiscoveryAttemptKey({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-1' })

    expect(buildModelDiscoveryAttemptKey({ provider: 'deepseek', baseUrl: 'https://gateway.example.com/v1', apiKey: 'sk-1' })).not.toBe(base)
    expect(buildModelDiscoveryAttemptKey({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-2' })).not.toBe(base)
  })
})

describe('shouldAutoDiscoverModels', () => {
  const ready = {
    canDiscover: true,
    modelCount: 0,
    fetching: false,
    awaitingCredentials: false,
    userEditedModels: false,
    attemptKey: 'deepseek|https://api.deepseek.com|sk-1',
    lastAttemptKey: null,
  }

  test('Given 地址与凭证就绪且没有任何模型 When 尚未尝试过该组合 Then 自动发现', () => {
    expect(shouldAutoDiscoverModels(ready)).toBe(true)
  })

  test('Given 已经尝试过同一组合 When 再次渲染 Then 不重复请求', () => {
    expect(shouldAutoDiscoverModels({ ...ready, lastAttemptKey: ready.attemptKey })).toBe(false)
  })

  test('Given 已有模型清单 When 渲染 Then 不覆盖已有配置', () => {
    expect(shouldAutoDiscoverModels({ ...ready, modelCount: 2 })).toBe(false)
  })

  test('Given 凭证缺失或正在请求 When 渲染 Then 不发起自动发现', () => {
    expect(shouldAutoDiscoverModels({ ...ready, canDiscover: false })).toBe(false)
    expect(shouldAutoDiscoverModels({ ...ready, fetching: true })).toBe(false)
  })

  test('Given 编辑模式凭证尚未加载或用户手动增删过模型 When 渲染 Then 不介入用户配置', () => {
    expect(shouldAutoDiscoverModels({ ...ready, awaitingCredentials: true })).toBe(false)
    expect(shouldAutoDiscoverModels({ ...ready, userEditedModels: true })).toBe(false)
  })
})
