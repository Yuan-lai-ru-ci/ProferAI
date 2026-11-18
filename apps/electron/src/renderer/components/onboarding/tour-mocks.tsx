/**
 * tour-mocks — 首次引导里用真实 DOM 画的「产品界面缩影」。
 *
 * 为什么不用截图：截图会随主题/版本过期，也看不清重点；这里每个 mock 只保留
 * 一个信息点，用界面语言讲功能，尺寸固定在 460×360 左右，右侧栏在窄窗口可整体隐藏。
 */

import * as React from 'react'
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Clock3,
  FileSpreadsheet,
  FileText,
  FolderClosed,
  Loader2,
  Mic,
  Paperclip,
  Sparkles,
  ToggleRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/** 窗口外壳：统一圆角、描边和标题条，让 4 个 mock 看起来是同一个产品。 */
function MockShell({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}): React.ReactElement {
  return (
    <div
      className={cn(
        'relative w-full overflow-hidden rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-[var(--shadow-lg)]',
        className,
      )}
      aria-hidden="true"
    >
      <div className="flex items-center gap-2 border-b border-[hsl(var(--border))] px-4 py-2.5">
        <span className="size-2 rounded-full bg-[hsl(var(--muted))]" />
        <span className="size-2 rounded-full bg-[hsl(var(--muted))]" />
        <span className="size-2 rounded-full bg-[hsl(var(--muted))]" />
        <span className="ml-2 truncate font-mono text-[10px] tracking-[0.18em] text-[hsl(var(--muted-foreground) / 0.7)]">{label}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function Bubble({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'solid' }): React.ReactElement {
  return (
    <div
      className={cn(
        'max-w-[86%] rounded-2xl px-3 py-2 text-[12px] leading-relaxed',
        tone === 'solid' ? 'rounded-br-md bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'rounded-bl-md bg-[hsl(var(--muted))] text-[hsl(var(--foreground))]',
      )}
    >
      {children}
    </div>
  )
}

/** 1. Chat：一问一答，突出「不用配置，打开就问」。 */
export function ChatMock(): React.ReactElement {
  return (
    <MockShell label="CHAT">
      <div className="flex flex-col gap-2.5">
        <div className="flex justify-end">
          <Bubble tone="solid">把这段话改成给客户看的正式邮件</Bubble>
        </div>
        <div className="flex items-start gap-2">
          <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-[hsl(var(--muted))] text-[hsl(var(--foreground) / 0.8)]">
            <Sparkles className="size-3" />
          </span>
          <Bubble>
            好的。我保留了事实，把语气调整为对客户的书面表达，并补了一句明确的下一步：
            <span className="mt-1.5 block text-[hsl(var(--muted-foreground))]">「如您方便，本周三前回复即可，我们会同步排期。」</span>
          </Bubble>
        </div>
        <div className="mt-1 flex items-center gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted) / 0.6)] px-3 py-2 text-[11px] text-[hsl(var(--muted-foreground) / 0.7)]">
          <Paperclip className="size-3.5" />
          继续追问，或粘贴一段新的内容
          <span className="ml-auto flex items-center gap-1.5">
            <Mic className="size-3.5" />
            <ArrowUpRight className="size-3.5" />
          </span>
        </div>
      </div>
    </MockShell>
  )
}

const AGENT_STEPS = [
  { label: '读取 销售.xlsx', state: 'done' as const },
  { label: '汇总 3 个季度、12 个区域', state: 'done' as const },
  { label: '找出下滑原因并写成报告', state: 'running' as const },
]

/** 2. Agent：多步执行 + 结果落盘，突出「会动手」。 */
export function AgentMock(): React.ReactElement {
  return (
    <MockShell label="AGENT">
      <div className="flex items-center gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted) / 0.6)] px-3 py-2 text-[12px] text-[hsl(var(--foreground) / 0.8)]">
        <span className="grid size-5 place-items-center rounded-full bg-[hsl(var(--muted))] text-[10px]">你</span>
        分析 <span className="rounded bg-[hsl(var(--muted))] px-1 font-mono text-[11px] text-[hsl(var(--foreground))]">@销售.xlsx</span>，找出下滑原因
      </div>

      <div className="mt-4 space-y-2.5">
        {AGENT_STEPS.map((step) => (
          <div key={step.label} className="flex items-center gap-2.5 text-[12px]">
            <span
              className={cn(
                'grid size-5 shrink-0 place-items-center rounded-full border',
                step.state === 'done'
                  ? 'border-[hsl(var(--border))] bg-[hsl(var(--muted))] text-[hsl(var(--foreground) / 0.8)]'
                  : 'border-[hsl(var(--border))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]',
              )}
            >
              {step.state === 'done' ? <Check className="size-3" /> : <Loader2 className="size-3 animate-spin" />}
            </span>
            <span className={step.state === 'done' ? 'text-[hsl(var(--muted-foreground))] line-through decoration-white/20' : 'text-[hsl(var(--foreground))]'}>
              {step.label}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted) / 0.6)] p-3">
        <div className="flex items-center gap-2 text-[12px] text-[hsl(var(--foreground))]">
          <FileText className="size-4 text-[hsl(var(--foreground) / 0.68)]" />
          销售下滑分析.md
          <span className="ml-auto rounded-full bg-[hsl(var(--primary) / 0.12)] px-2 py-0.5 text-[10px] text-[hsl(var(--primary))]">已生成</span>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-[hsl(var(--muted-foreground))]">12 条结论 · 3 张图表 · 已重新读取文件确认内容</p>
      </div>
    </MockShell>
  )
}

const WORKSPACE_FILES = [
  { name: '销售.xlsx', icon: FileSpreadsheet, active: true },
  { name: '季度总结.md', icon: FileText },
  { name: 'assets', icon: FolderClosed },
]

/** 3. 工作区：文件树 + @ 引用，突出「文件就是上下文」。 */
export function WorkspaceMock(): React.ReactElement {
  return (
    <MockShell label="WORKSPACE">
      <div className="flex gap-3">
        <div className="w-[42%] space-y-1 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted) / 0.6)] p-2">
          <p className="px-1 pb-1 font-mono text-[9px] tracking-[0.16em] text-[hsl(var(--muted-foreground) / 0.7)]">项目 / 2026 Q3</p>
          {WORKSPACE_FILES.map((file) => (
            <div
              key={file.name}
              className={cn(
                'flex items-center gap-2 rounded-lg px-2 py-1.5 text-[11px]',
                file.active ? 'bg-[hsl(var(--muted))] text-[hsl(var(--foreground))]' : 'text-[hsl(var(--muted-foreground))]',
              )}
            >
              <file.icon className="size-3.5" />
              <span className="truncate">{file.name}</span>
            </div>
          ))}
        </div>

        <div className="relative min-h-[190px] flex-1 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted) / 0.6)] p-3">
          <p className="text-[10px] text-[hsl(var(--muted-foreground) / 0.7)]">季度总结.md</p>
          <div className="mt-2 space-y-1.5">
            <div className="h-1.5 w-4/5 rounded-full bg-[hsl(var(--muted))]" />
            <div className="h-1.5 w-full rounded-full bg-[hsl(var(--muted))]" />
            <div className="h-1.5 w-3/5 rounded-full bg-[hsl(var(--muted))]" />
          </div>
          <div className="absolute inset-x-3 bottom-3 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-2 shadow-[var(--shadow-md)]">
            <div className="flex items-center gap-1.5 text-[11px] text-[hsl(var(--foreground) / 0.8)]">
              <span className="grid size-4 place-items-center rounded bg-[hsl(var(--muted))] font-mono text-[10px]">@</span>
              引用工作区文件
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 rounded-md bg-[hsl(var(--muted) / 0.6)] px-2 py-1 text-[10px] text-[hsl(var(--muted-foreground))]">
              <FileSpreadsheet className="size-3" />
              销售.xlsx
            </div>
          </div>
        </div>
      </div>
    </MockShell>
  )
}

/** 5. 规划与自动化：日程 + 定时任务，突出「到点自己发生」。 */
export function PlanningMock(): React.ReactElement {
  const days = ['一', '二', '三', '四', '五', '六', '日']
  return (
    <MockShell label="PLANNING">
      <div className="flex items-center justify-between text-[11px] text-[hsl(var(--muted-foreground) / 0.7)]">
        <span>10 月 20 日 — 26 日</span>
        <span className="flex items-center gap-1 text-[hsl(var(--foreground) / 0.68)]">
          今天
          <ChevronRight className="size-3" />
        </span>
      </div>
      <div className="mt-2 grid grid-cols-7 gap-1">
        {days.map((day, index) => (
          <div
            key={day}
            className={cn(
              'flex flex-col items-center gap-1 rounded-lg py-1.5 text-[10px]',
              index === 4 ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'text-[hsl(var(--muted-foreground))]',
            )}
          >
            {day}
            <span className={cn('size-1 rounded-full', index === 4 ? 'bg-[hsl(var(--primary-foreground))]' : 'bg-[hsl(var(--muted))]')} />
          </div>
        ))}
      </div>

      <div className="mt-3 space-y-1.5">
        <div className="flex items-center gap-2 rounded-lg bg-[hsl(var(--muted) / 0.6)] px-2.5 py-2 text-[11px] text-[hsl(var(--foreground) / 0.8)]">
          <span className="size-3 rounded border border-[hsl(var(--border))]" />
          整理上周项目进展
          <span className="ml-auto font-mono text-[9px] text-[hsl(var(--muted-foreground) / 0.7)]">09:00</span>
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-[hsl(var(--muted) / 0.6)] px-2.5 py-2 text-[11px] text-[hsl(var(--muted-foreground))]">
          <span className="size-3 rounded border border-[hsl(var(--border))]" />
          给设计稿提反馈
          <span className="ml-auto font-mono text-[9px] text-[hsl(var(--muted-foreground) / 0.7)]">14:30</span>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted) / 0.6)] px-3 py-2.5">
        <Clock3 className="size-3.5 text-[hsl(var(--muted-foreground))]" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] text-[hsl(var(--foreground))]">每周一 09:00 · 自动运行</p>
          <p className="text-[10px] text-[hsl(var(--muted-foreground) / 0.7)]">结果写回会话，并推送提醒</p>
        </div>
        <ToggleRight className="size-4 text-[hsl(var(--primary))]" />
      </div>
    </MockShell>
  )
}
