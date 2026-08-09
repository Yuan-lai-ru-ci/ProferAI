import type { ModelAvailability, ModelAvailabilitySample } from '@profer/shared'

export interface AggregatedModelHealth {
  model: ModelAvailability
  /** Fixed-size time buckets; null means no request in that period. */
  slots: Array<ModelAvailabilitySample | null>
}

const BUCKET_COUNT = 32

export function aggregateModelHealth(models: ModelAvailability[]): AggregatedModelHealth | null {
  const samples = models.flatMap((model) => model.samples)
  if (samples.length === 0) return null

  const sorted = [...samples].sort((a, b) => b.createdAt - a.createdAt)
  // 取全渠道最近 32 次真实请求。空位仅代表历史不足，不代表某个时间段故障。
  const recent = sorted.slice(0, BUCKET_COUNT).reverse()
  const slots: Array<ModelAvailabilitySample | null> = [
    ...Array.from({ length: Math.max(0, BUCKET_COUNT - recent.length) }, () => null),
    ...recent,
  ]

  // 数值与健康条使用同一窗口，避免“条全红但百分比仍很高”的矛盾。
  const successCount = recent.filter((sample) => sample.status === 'success').length
  const modelId = models[0]!.modelId
  const end = sorted[0]!.createdAt
  return {
    model: {
      modelId,
      availability: Math.round((successCount / recent.length) * 100),
      sampleCount: recent.length,
      avgLatencyMs: Math.round(recent.reduce((total, sample) => total + sample.durationMs, 0) / recent.length),
      updatedAt: end,
      samples: slots.filter((sample): sample is ModelAvailabilitySample => sample !== null),
    },
    slots,
  }
}
