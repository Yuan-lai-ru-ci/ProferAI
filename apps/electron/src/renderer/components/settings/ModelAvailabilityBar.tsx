import * as React from 'react'
import type { ModelAvailability } from '@profer/shared'

interface ModelAvailabilityBarProps {
  model: ModelAvailability
  /** 聚合渠道视图已在外层显示模型名时，隐藏内部重复标题。 */
  compact?: boolean
  /** 固定长度的聚合时间桶；空桶显示为灰色。 */
  samples?: Array<ModelAvailability['samples'][number] | null>
}

function statusColor(status: ModelAvailability['samples'][number]['status']): string {
  if (status === 'failure') return 'bg-red-500'
  if (status === 'degraded') return 'bg-amber-400'
  return 'bg-lime-500'
}

export function ModelAvailabilityBar({ model, compact = false, samples: samplesProp }: ModelAvailabilityBarProps): React.ReactElement {
  const percentage = model.availability
  const tone = percentage === null ? 'text-muted-foreground' : percentage >= 90 ? 'text-lime-600 dark:text-lime-400' : percentage >= 70 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'
  const samples = samplesProp ?? (model.samples.length ? model.samples : Array.from({ length: 32 }, () => null))

  return (
    <div className={`grid min-w-0 ${compact ? 'grid-cols-[minmax(0,1fr)_52px]' : 'grid-cols-[minmax(140px,220px)_minmax(0,1fr)_52px]'} items-center gap-4 py-2`} title={percentage === null ? '暂无可用性数据' : `最近 ${model.sampleCount} 次请求，可用率 ${percentage}%`}>
      {!compact && <span className="truncate text-sm text-foreground/80">{model.modelId}</span>}
      <div className="flex min-w-0 items-center gap-[3px]" aria-label={percentage === null ? '暂无可用性数据' : `可用率 ${percentage}%`}>
        {samples.map((sample, index) => (
          <span
            key={`${model.modelId}-${index}`}
            className={`${compact ? 'h-2 rounded-none' : 'h-4 rounded-full'} min-w-[3px] flex-1 ${sample ? statusColor(sample.status) : 'bg-muted-foreground/20'}`}
          />
        ))}
      </div>
      <span className={`text-right text-base font-semibold tabular-nums ${tone}`}>
        {percentage === null ? '—' : `${percentage}%`}
      </span>
    </div>
  )
}
