import { describe, expect, test } from 'bun:test'
import type { ModelAvailability, ModelAvailabilitySample } from '@profer/shared'
import { aggregateModelHealth } from './channel-health-aggregation'

function model(samples: ModelAvailabilitySample[], modelId = 'gpt-5.6-terra'): ModelAvailability {
  return {
    modelId,
    availability: null,
    sampleCount: samples.length,
    avgLatencyMs: null,
    updatedAt: samples.at(-1)?.createdAt ?? null,
    samples,
  }
}

function sample(status: ModelAvailabilitySample['status'], createdAt: number, durationMs = 1000): ModelAvailabilitySample {
  return { status, createdAt, durationMs }
}

describe('aggregateModelHealth', () => {
  test('慢响应但已成功的 degraded 样本仍计入可用率', () => {
    const result = aggregateModelHealth([
      model([
        sample('success', 1),
        sample('degraded', 2, 12_000),
        sample('failure', 3),
      ]),
    ])

    expect(result?.model.availability).toBe(67)
    expect(result?.model.sampleCount).toBe(3)
    expect(result?.slots.slice(-3).map((item) => item?.status)).toEqual(['success', 'degraded', 'failure'])
  })

  test('只把 failure 计为不可用', () => {
    const result = aggregateModelHealth([
      model([sample('degraded', 1, 20_000), sample('degraded', 2, 30_000)]),
    ])

    expect(result?.model.availability).toBe(100)
  })

  test('跨渠道只取按时间排序后的最近 32 条样本', () => {
    const older = Array.from({ length: 20 }, (_, index) => sample('failure', index + 1))
    const newer = Array.from({ length: 20 }, (_, index) => sample('success', index + 21))
    const result = aggregateModelHealth([model(older), model(newer)])

    expect(result?.model.sampleCount).toBe(32)
    expect(result?.model.availability).toBe(63)
    expect(result?.slots.filter(Boolean)).toHaveLength(32)
  })
})
