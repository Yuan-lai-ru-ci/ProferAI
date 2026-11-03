import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@profer/ui/primitives/tooltip'
import type { AgentSessionMeta } from '@profer/shared'
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
