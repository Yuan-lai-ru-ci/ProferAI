/**
 * dev-only 视觉预览：首次引导（OnboardingView）与功能导览（FeatureTour）。
 *
 * 仅在 vite dev 下访问 /onboarding-preview.html，不参与打包入口。
 * 与 profile-preview 同一套路：内存 mock 注入 electronAPI，不读真实用户数据。
 *
 * 参数：
 *   ?step=welcome | featureTour | environment | migration
 *   ?skin=slate-light（默认，用 globals.css 的 theme-* 表复现真实配色）
 *   ?theme=light | dark —— 只在没有 skin 时生效
 */

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { getDefaultStore } from 'jotai'
import { Toaster } from '@profer/ui'
import { TooltipProvider } from '@profer/ui/primitives/tooltip'
import { OnboardingView } from '@/components/onboarding/OnboardingView'
import { runtimeStatusAtom } from '@/atoms/environment'
import '../styles/globals.css'

type Step = 'welcome' | 'featureTour' | 'environment' | 'migration'

const params = new URLSearchParams(location.search)
const startStep = (params.get('step') ?? 'welcome') as Step
const themeMode = params.get('theme') === 'dark' ? 'dark' : 'light'
const skinId = params.get('skin') ?? 'slate-light'

if (themeMode === 'dark') document.documentElement.classList.add('dark')
document.documentElement.setAttribute('data-platform', 'darwin')

// 用 globals.css 里现成的 theme-* token 表复现真实配色（slate-light 等）。
// 默认白底会让「灰底分区」这类判断完全失真；也不去读 ~/.profer/skin-cache，
// 避免预览页依赖 vite 的 fs 白名单。
document.documentElement.classList.add(`theme-${skinId}`)

const delay = <T,>(value: T, ms = 80): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms))

const runtimeStatus = {
  node: { available: true, version: '22.11.0' },
  bun: { available: true, version: '1.4.2' },
  git: { available: true, version: '2.54.0' },
  envLoaded: true,
  initializedAt: Date.now(),
}

const mock = {
  getSettings: () => delay({ onboardingCompleted: false, themeMode }),
  updateSettings: () => delay(undefined),
  listCalendarEvents: () => delay([]),
  createCalendarEvent: () => delay({}),
  reinitRuntime: () => delay(runtimeStatus, 240),
  getRuntimeStatus: () => delay(runtimeStatus, 120),
  fetchInstallerManifest: () => delay({ installers: [] }, 160),
}

Object.assign(window, { electronAPI: mock })

getDefaultStore().set(runtimeStatusAtom, runtimeStatus as never)

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TooltipProvider>
      <OnboardingView initialStep={startStep} persistCompletion={false} onComplete={() => undefined} />
      <Toaster theme={themeMode} position="top-right" offset={16} />
    </TooltipProvider>
  </React.StrictMode>,
)
