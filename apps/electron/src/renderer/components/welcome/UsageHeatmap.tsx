/**
 * UsageHeatmap — 工作区编码活跃热力图
 *
 * 纯 CSS Grid + shadcn/ui Tooltip 实现，使用 Profer 自身设计 token：
 * - 色阶用 --primary CSS 变量，自动适配所有主题（森林绿 / 海洋蓝 / 石板灰...）
 * - Tooltip 用 shadcn/ui 原生组件，与全局 UI 一致
 * - 深色模式通过 CSS 变量自动切换，无需单独配置
 *
 * 布局参考 GitHub 贡献图：7 行（周一~周日）× 53 列（约一年）
 */
import * as React from 'react'
import { useAtomValue } from 'jotai'
import { currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { toCalendarData, type WorkspaceHeatmapEntry } from '@/lib/heatmap-utils'

// ── 布局常量 ──────────────────────────────────────────────
const CELL = 11                         // 格子尺寸 px
const GAP = 3                           // 间距 px
const STEP = CELL + GAP                 // 格子+间距
const WEEKS = 26                        // 约半年
const DAY_LABELS = ['一', '', '三', '', '五', '', '日']
const MONTH_NAMES = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月']

// ── 色阶：用 Profer 的 --primary token，opacity 控制深浅 ──
// 这样自动适配所有主题（forest-light=绿, ocean=蓝, slate=灰...）
const LEVEL_CLASSES = [
  'bg-muted',         // 0 — 无活动，用 muted 底色清晰可见
  'bg-primary/20',    // 1 — 淡
  'bg-primary/40',    // 2 — 中
  'bg-primary/65',    // 3 — 深
  'bg-primary',       // 4 — 最浓
]

// ── 工具函数 ──────────────────────────────────────────────

function buildWeekGrid(entries: WorkspaceHeatmapEntry[], weeks: number = WEEKS) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const todayDay = (today.getDay() + 6) % 7 // Mon=0
  const startDate = new Date(today)
  startDate.setDate(startDate.getDate() - todayDay - (weeks - 1) * 7)

  const valueMap = new Map<string, number>()
  for (const e of entries) valueMap.set(e.date, e.tokens)

  const cells: Array<Array<{ date: string; value: number; level: number; future: boolean } | null>> = []
  const monthLabels: Array<{ label: string; col: number }> = []
  let lastMonth = -1

  // 用百分位阈值算 level
  const calendarData = toCalendarData(entries)
  const levelMap = new Map(calendarData.map(d => [d.date, d.level]))

  for (let col = 0; col < weeks; col++) {
    const row: Array<{ date: string; value: number; level: number; future: boolean } | null> = []
    for (let r = 0; r < 7; r++) {
      const d = new Date(startDate)
      d.setDate(startDate.getDate() + col * 7 + r)
      const dateStr = d.toISOString().slice(0, 10)
      const future = d.getTime() > today.getTime()

      if (future) {
        row.push(null)
        continue
      }

      const value = valueMap.get(dateStr) ?? 0
      const level = levelMap.get(dateStr) ?? 0
      row.push({ date: dateStr, value, level, future: false })

      // 月份标签（每周一检查）
      if (r === 0) {
        const month = d.getMonth()
        if (month !== lastMonth) {
          const prev = monthLabels[monthLabels.length - 1]
          const monthLabel = MONTH_NAMES[month] ?? ''
          if (prev && col - prev.col < 3) {
            monthLabels[monthLabels.length - 1] = { label: monthLabel, col }
          } else {
            monthLabels.push({ label: monthLabel, col })
          }
          lastMonth = month
        }
      }
    }
    cells.push(row)
  }

  return { cells, monthLabels }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function formatLabel(date: string, tokens: number): string {
  if (tokens === 0) return `${date}\n无消耗`
  return `${date}\n${formatTokens(tokens)} tokens`
}

// ── 组件 ──────────────────────────────────────────────────

export function UsageHeatmap(): React.ReactElement {
  const workspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const [entries, setEntries] = React.useState<WorkspaceHeatmapEntry[] | null>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    if (!workspaceId) { setLoading(false); return }
    let cancelled = false
    setLoading(true)
    window.electronAPI.getWorkspaceHeatmapDaily(workspaceId)
      .then(d => { if (!cancelled) setEntries(d) })
      .catch(() => { if (!cancelled) setEntries([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workspaceId])

  // ── 加载态 ──
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[140px]">
        <span className="text-[13px] text-muted-foreground/50">加载中...</span>
      </div>
    )
  }

  // ── 无数据态 ──
  if (!entries || entries.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[140px]">
        <span className="text-[13px] text-muted-foreground/50">
          开始你的第一个 Agent 会话，Token 消耗热力图将在这里显示
        </span>
      </div>
    )
  }

  const { cells, monthLabels } = buildWeekGrid(entries)

  return (
    <div className="select-none px-1">
      {/* ── 月份标签行 ── */}
      <div className="relative mb-[2px] ml-7 h-[14px]">
        {monthLabels.map((ml) => (
          <span
            key={ml.label}
            className="absolute top-0 text-[10px] text-muted-foreground/70 whitespace-nowrap"
            style={{ left: ml.col * STEP }}
          >
            {ml.label}
          </span>
        ))}
      </div>

      <div className="flex gap-[2px]">
        {/* ── 星期标签 ── */}
        <div className="flex flex-col shrink-0 mr-[2px]" style={{ gap: GAP }}>
          {DAY_LABELS.map((label, i) => (
            <span
              key={i}
              className="text-[10px] text-muted-foreground/50 leading-none flex items-center"
              style={{ height: CELL, width: 26 }}
            >
              {label}
            </span>
          ))}
        </div>

        {/* ── 热力网格 ── */}
        <div className="overflow-x-auto">
          <div
            className="grid"
            style={{
              gridTemplateRows: `repeat(7, ${CELL}px)`,
              gridAutoFlow: 'column',
              gap: GAP,
            }}
          >
            {cells.flat().map((cell, idx) => {
              if (!cell) {
                return <div key={`empty-${idx}`} style={{ width: CELL, height: CELL }} />
              }
              return (
                <Tooltip key={cell.date} delayDuration={200}>
                  <TooltipTrigger asChild>
                    <div
                      className={`rounded-[2px] ${LEVEL_CLASSES[cell.level]} transition-colors hover:!opacity-80 hover:ring-1 hover:ring-primary/30`}
                      style={{ width: CELL, height: CELL }}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs px-2 py-1">
                    {formatLabel(cell.date, cell.value)}
                  </TooltipContent>
                </Tooltip>
              )
            })}
          </div>
        </div>
      </div>

      {/* ── 图例 ── */}
      <div className="flex items-center justify-end gap-1 mt-2 text-[10px] text-muted-foreground/60">
        <span>少</span>
        {LEVEL_CLASSES.map((cls, i) => (
          <div
            key={i}
            className={`rounded-[2px] ${cls}`}
            style={{ width: CELL, height: CELL }}
          />
        ))}
        <span>多</span>
      </div>
    </div>
  )
}
