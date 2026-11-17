/**
 * dev-only 视觉预览：界面蒙层引导（CoachTourOverlay）。
 *
 * 真实 App 的锚点是 data-tour / data-profer-navigation-* / data-input-mode，
 * 这里用最小外壳复刻这些属性，让 overlay 的测量、定位、聚光灯都能真跑一遍。
 *
 * 参数：
 *   ?step=0..5（起始步骤，默认 0）
 *   ?skin=slate-light | slate-dark（默认 slate-light）
 */

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { Toaster } from '@profer/ui'
import { coachTourOpenAtom } from '@/atoms/coach-tour-atoms'
import { CoachTourOverlay } from '@/components/onboarding/coach-tour/CoachTourOverlay'
import { COACH_TOUR_STEPS } from '@/components/onboarding/coach-tour/coach-tour-steps'
import '../styles/globals.css'

const params = new URLSearchParams(location.search)
const skinId = params.get('skin') ?? 'slate-light'
document.documentElement.classList.add(`theme-${skinId}`)
document.documentElement.setAttribute('data-platform', 'darwin')

// 预览页没有 IPC：引导退出时会写 coachTourVersion，这里吞掉。
Object.assign(window, { electronAPI: { updateSettings: () => Promise.resolve(undefined) } })

const store = createStore()
store.set(coachTourOpenAtom, true)

const NAV = [
  { item: 'new-session', label: '新会话' },
  { item: 'planning-todos', label: 'Todo' },
  { item: 'planning-calendar', label: '日程' },
  { item: 'planning-automations', label: '定时任务' },
  { item: 'agent-skills', label: 'Agent 技能' },
  { item: 'agent-memory', label: 'Agent 记忆' },
]

function Shell(): React.ReactElement {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <aside className="flex w-[260px] shrink-0 flex-col gap-1 border-r border-border bg-sidebar p-3">
        <div data-tour="mode-switch" data-profer-navigation-region="mode-switcher" className="flex rounded-lg bg-muted p-1">
          <span className="flex-1 rounded-md bg-background px-2 py-1.5 text-center text-[11px] font-medium shadow-sm">Agent</span>
          <span className="flex-1 px-2 py-1.5 text-center text-[11px] text-muted-foreground">Chat</span>
        </div>
        {NAV.map((nav) => (
          <button
            key={nav.item}
            type="button"
            data-profer-navigation-item={nav.item}
            className="flex items-center rounded-md px-2 py-2 text-left text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {nav.label}
          </button>
        ))}
      </aside>

      <main
        data-profer-navigation-region="conversation"
        className="flex min-w-0 flex-1 flex-col bg-content-area"
      >
        <div className="flex h-11 shrink-0 items-center border-b border-border px-4 text-[12px] font-medium">
          新 Agent 会话
        </div>
        <div className="flex flex-1 items-center justify-center px-6">
          <div className="w-full max-w-xl text-center text-[13px] text-muted-foreground">
            说清目标，剩下的交给它。
          </div>
        </div>
        <div className="p-4">
          <div
            data-input-mode="agent"
            data-profer-navigation-region="toolbar"
            className="mx-auto flex w-full max-w-xl items-center gap-2 rounded-xl border border-border bg-input-surface px-3 py-2.5 text-[12px] text-muted-foreground"
          >
            描述任务，@ 引用文件…
          </div>
        </div>
      </main>

      <CoachTourOverlay />
      <Toaster position="top-right" offset={16} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <Shell />
    </Provider>
  </React.StrictMode>,
)

// 起始步骤：按文字点「下一步」（真实用户路径），逐帧截图用。
const startStep = Number(params.get('step') ?? '0')
if (startStep > 0 && Number.isFinite(startStep)) {
  for (let i = 0; i < startStep; i += 1) {
    window.setTimeout(() => {
      const dialog = document.querySelector('[role="dialog"]')
      const buttons = Array.from(dialog?.querySelectorAll('button') ?? [])
      const nextButton = buttons.find((button) => button.textContent?.includes('下一步'))
      nextButton?.click()
    }, 500 + i * 300)
  }
}
