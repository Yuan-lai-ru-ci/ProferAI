import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@profer/ui/primitives/tooltip'
import type { AgentGoalState, AgentSessionMeta } from '@profer/shared'
import { browserStateMapAtom } from '@/atoms/browser-atoms'
import { AgentSessionItem } from './session-items'

/**
 * 行首状态标记的渲染契约：
 * 统一 11px 线性图标、按固定顺序内联堆叠；没有标记的会话不占位（标题贴左）。
 */

const session = (overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta => ({
  id: 'session-1',
  title: '本地部署workbuddy2api',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

function renderSession(options: {
  session: AgentSessionMeta
  depth?: 0 | 1
  showPinIcon?: boolean
  hasBrowser?: boolean
  goalStatus?: AgentGoalState['status']
  regeneratingTitle?: boolean
}): string {
  const store = createStore()
  if (options.hasBrowser) {
    store.set(browserStateMapAtom, new Map([[options.session.id, {} as never]]))
  }
  return renderToStaticMarkup(
    <Provider store={store}>
      <TooltipProvider>
        <AgentSessionItem
          session={options.session}
          active={false}
          indicatorStatus="idle"
          depth={options.depth ?? 1}
          showPinIcon={options.showPinIcon ?? true}
          goalStatus={options.goalStatus}
          regeneratingTitle={options.regeneratingTitle}
          relativeTimeNow={1}
          onSelect={() => {}}
          onRequestDelete={() => {}}
          onRequestMove={() => {}}
          onRename={async () => {}}
          onTogglePin={async () => {}}
          onToggleArchive={async () => {}}
        />
      </TooltipProvider>
    </Provider>,
  )
}

describe('会话行首状态标记', () => {
  test('Given 置顶且在用浏览器 When 渲染 Then 按 置顶→浏览器 顺序内联堆叠', () => {
    const html = renderSession({
      session: session({ pinned: true }),
      hasBrowser: true,
    })

    expect(html).toContain('data-session-markers')
    expect(html.indexOf('lucide-pin')).toBeGreaterThan(-1)
    expect(html.indexOf('lucide-pin')).toBeLessThan(html.indexOf('lucide-globe'))
    // 标记参与行内布局：不再用绝对定位槽，标题不会被压到图标下面
    expect(html).not.toContain('absolute left-2')
    // 标题紧跟在标记之后
    expect(html.indexOf('lucide-globe')).toBeLessThan(html.indexOf('本地部署workbuddy2api'))
  })

  test('Given 没有任何标记 When 渲染 Then 不渲染标记容器（标题贴左不缩进）', () => {
    const html = renderSession({ session: session() })

    expect(html).not.toContain('data-session-markers')
  })
})

describe('会话行 Goal 标记', () => {
  test('Given 会话有未结束的 Goal When 渲染 Then 置顶后显示靶心图标', () => {
    const html = renderSession({
      session: session({ pinned: true }),
      depth: 0,
      goalStatus: 'active',
    })

    expect(html.indexOf('lucide-pin')).toBeGreaterThan(-1)
    expect(html.indexOf('lucide-pin')).toBeLessThan(html.indexOf('lucide-target'))
    expect(html.indexOf('lucide-target')).toBeLessThan(html.indexOf('本地部署workbuddy2api'))
  })

  test('Given Goal 需要你处理 When 渲染 Then 靶心用 warning 色', () => {
    const html = renderSession({ session: session(), goalStatus: 'blocked' })

    expect(html).toContain('lucide-target')
    expect(html).toContain('text-warning')
  })

  test('Given Goal 正常推进 When 渲染 Then 靶心保持中性灰（不新造色相）', () => {
    const html = renderSession({ session: session(), goalStatus: 'active' })

    expect(html).toContain('lucide-target')
    expect(html).not.toContain('text-warning')
  })

  test('Given Goal 已结束 When 渲染 Then 不再渲染靶心', () => {
    const html = renderSession({ session: session(), goalStatus: 'completed' })

    expect(html).not.toContain('data-session-markers')
    expect(html).not.toContain('lucide-target')
  })

  test('Given 标记超过上限 When 渲染 Then 只留前三枚并折叠成 +N', () => {
    const html = renderSession({
      session: session({ pinned: true, sourceAutomationId: 'auto-1' }),
      depth: 0,
      hasBrowser: true,
      regeneratingTitle: true,
      goalStatus: 'active',
    })

    // 置顶 + 靶心 + 浏览器 + 生成标题 = 4 枚，Goal 已压掉定时来源
    expect(html).toContain('lucide-pin')
    expect(html).toContain('lucide-target')
    expect(html).toContain('lucide-globe')
    expect(html).not.toContain('lucide-clock')
    expect(html).toContain('data-session-markers-overflow')
    expect(html).toContain('+1')
  })
})
