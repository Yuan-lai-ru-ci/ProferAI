import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserPageMenu } from '../src/renderer/components/browser/BrowserPageMenu'

const pages = [
  { tabId: 'user', url: 'https://example.com/read', title: '当前阅读的用户页面', localFile: null, loading: false, zoomFactor: 1, openedByAgent: false },
  { tabId: 'work', url: 'https://example.com/research', title: 'Agent 正在后台研究的网页', localFile: null, loading: true, zoomFactor: 1, openedByAgent: true },
  { tabId: 'preview', url: 'profer-file://test-only', title: '分析结果 · 本地预览', localFile: { name: '报告.html', readOnly: true as const }, loading: false, zoomFactor: 1, openedByAgent: true },
]
function Fixture(): React.ReactElement {
  const [active, setActive] = React.useState('user')
  return <div className="h-full bg-background p-6 text-foreground">
    <section className="mx-auto flex h-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-content-area shadow-sm">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">后台浏览器页面测试</span>
        <BrowserPageMenu pages={pages} activeTabId={active} agentTabId="work" onSelect={setActive} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6">
        <p className="text-sm">后台工作不改变当前阅读页</p>
        <p id="selected" role="status" className="text-xs text-muted-foreground">{active}</p>
      </div>
    </section>
  </div>
}
const root = document.getElementById('root')
if (!root) throw new Error('测试 root 不存在')
createRoot(root).render(<Fixture />)
