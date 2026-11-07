/**
 * dev-only 视觉预览：用真实 GlobalProfileView + 真实主题 token 渲染「我的画像」。
 *
 * 仅在 vite dev 下访问 /profile-preview.html，不参与打包入口。
 * 通过内存 mock 注入 electronAPI，覆盖 filled / empty / error 三种状态：
 *   ?state=filled（默认，含手写正文与推断结论）
 *   ?state=empty（全新用户）
 *   ?state=error（读取失败）
 * 主题：?theme=dark | light
 */

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { getDefaultStore } from 'jotai'
import { Toaster } from '@profer/ui'
import { TooltipProvider } from '@profer/ui/primitives/tooltip'
import { GlobalProfileView } from '@/components/user-profile/GlobalProfileView'
import { userProfileAtom } from '@/atoms/user-profile'
import { agentWorkspacesAtom } from '@/atoms/agent-atoms'
import '../styles/globals.css'

type State = 'filled' | 'empty' | 'error'

const params = new URLSearchParams(location.search)
const state = (params.get('state') ?? 'filled') as State
const isDark = document.documentElement.classList.contains('dark')

const TEMPLATE: Record<string, string> = {
  'MEMORY.md': '# 全局记忆索引\n',
  'user-profile.md': '# 用户背景\n\n<!-- 用户明确提供或确认的信息。 -->\n',
  'preferences.md': '# 稳定偏好\n\n<!-- 用户明确表达或确认的跨工作区偏好。 -->\n',
  'infrastructure/servers.md': '# 服务器\n\n<!-- 记录用途、系统、别名、访问方式与最近核对时间。 -->\n',
  'devices/README.md': '# 设备\n\n<!-- 按设备记录稳定配置与核对时间。 -->\n',
  'user-sense.md': '# 用户感知结论\n\n<!-- 本地扫描推断。 -->\n',
}

const FILLED: Record<string, string> = {
  ...TEMPLATE,
  'user-profile.md':
    '# 用户背景\n\n' +
    '<!-- 用户明确提供或确认的信息。 -->\n\n' +
    '独立创始人，一个人维护 Profer 桌面端与服务端；主力方向是 Electron 桌面应用与本地 Agent 运行时。\n\n' +
    '## 称呼\n\n源来如此\n\n' +
    '## 职业与领域\n\n独立开发者 · AI 桌面应用 / Electron\n\n' +
    '## 常用语言\n\n中文，技术术语保留英文\n\n' +
    '## 项目惯例\n\n- 改动前先看 git status 与现有 WIP\n- 注释用中文，语气平实克制\n- 视觉改动必须自己渲染检查\n',
  'preferences.md':
    '# 稳定偏好\n\n' +
    '<!-- 用户明确表达或确认的跨工作区偏好。 -->\n\n' +
    '## 协作偏好\n\n先给结论，代码要能直接运行，不做套路式对冲\n\n' +
    '## 验证与表述\n\n源码改动、单测、typecheck、构建、真机验收必须分别表述。\n',
  'devices/README.md':
    '# 设备\n\n- MacBook Pro · Apple Silicon · macOS 27.2 · 2026-10-30 核对\n- 工具链：Bun 1.4.2 / Node v26.8.1 / git 2.50.1\n',
  'infrastructure/servers.md':
    '# 服务器\n\n- Team Server（自建），用于多端会话同步；最近核对 2026-10-20\n',
  'user-sense.md':
    '# 用户感知结论\n\n' +
    '- 常在夜间（22:00 后）推进代码任务；单轮改动倾向于收窄到单个业务域。\n' +
    '- 偏好本地优先：联网检索只在需要时效信息时使用。\n' +
    '<!-- 来源：本地会话时间分布扫描；置信度：中；最近核对 2026-11-03。 -->\n',
}

const DOCS: Record<string, string> = { ...(state === 'filled' ? FILLED : TEMPLATE) }
let profileName = state === 'empty' ? '用户' : '源来如此'

const summary = () => ({
  indexExists: true,
  fileCount: Object.keys(DOCS).length,
  totalSize: Object.values(DOCS).reduce((sum, text) => sum + text.length, 0),
  updatedAt: Date.now() - 1000 * 60 * 60 * 26,
})

const delay = <T,>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), 90))

const mock = {
  getWorkspaceHeatmapDaily: (workspaceId: string) => delay(state === 'empty' ? [] : Array.from({ length: 365 }, (_, index) => {
    const date = new Date()
    date.setDate(date.getDate() - index - 1)
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    const tokens = ((index * 37 + (workspaceId === 'preview-2' ? 13 : 7)) % 9 < 3) ? 0 : ((index * 137 + 120) % 900 + 100) * 100
    return { date: key, tokens }
  })),
  getGlobalMemorySummary: () => delay(summary()),
  readGlobalMemoryFile: (path: string) => {
    if (state === 'error') return Promise.reject(new Error('模拟读取失败：全局记忆目录不可访问'))
    return delay({ relativePath: path, content: DOCS[path] ?? '', isText: true, size: (DOCS[path] ?? '').length })
  },
  writeGlobalMemoryFile: (path: string, content: string) => {
    DOCS[path] = content
    return delay(undefined)
  },
  updateUserProfile: (updates: { userName?: string; avatar?: string }) => {
    if (updates.userName) profileName = updates.userName
    return delay({ userName: profileName, avatar: '🧑‍💻' })
  },
  getUserProfile: () => delay({ userName: profileName, avatar: '🧑‍💻' }),
}

type ProfileProbe = {
  /** 当前 mock 文件全文，供预览页自测读回。 */
  docs: Record<string, string>
  /** 模拟填写一个字段（真实 input 事件 + blur），返回是否写盘成功。 */
  fill: (key: string, value: string) => Promise<boolean>
}
declare global {
  interface Window { __PROFILE_PROBE__?: ProfileProbe }
}

const setNativeValue = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const probe: ProfileProbe = {
  docs: DOCS,
  fill: async (key, value) => {
    const input = document.querySelector<HTMLInputElement>(`#profile-field-${key}`)
    if (!input) return false
    setNativeValue(input, value)
    input.dispatchEvent(new FocusEvent('blur', { bubbles: false }))
    await new Promise((resolve) => setTimeout(resolve, 350))
    return true
  },
}

Object.assign(window, { electronAPI: mock, __PROFILE_PROBE__: probe })

// 预览页没有 AppShell 的初始 IPC 加载，手动写入模拟档案和工作区。
getDefaultStore().set(agentWorkspacesAtom, [
  { id: 'preview-1', name: '工作区一', slug: 'preview-1', createdAt: 0, updatedAt: 0 },
  { id: 'preview-2', name: '工作区二', slug: 'preview-2', createdAt: 0, updatedAt: 0 },
])
getDefaultStore().set(userProfileAtom, {
  userName: state === 'empty' ? '用户' : '源来如此',
  avatar: '🧑‍💻',
})

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TooltipProvider>
      <div className="flex h-screen w-screen overflow-hidden bg-background">
        <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-content-area">
          <GlobalProfileView />
        </div>
      </div>
      <Toaster theme={isDark ? 'dark' : 'light'} position="top-right" offset={16} />
    </TooltipProvider>
  </React.StrictMode>,
)
