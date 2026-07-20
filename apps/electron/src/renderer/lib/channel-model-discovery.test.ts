import { describe, expect, test } from 'bun:test'
import type { ChannelModel, FetchModelsResult } from '@profer/shared'
import { applyModelDiscoveryResult } from './channel-model-discovery'

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
})
