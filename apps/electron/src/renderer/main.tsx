/**
 * 渲染进程入口
 *
 * 挂载 React 应用，初始化主题系统。
 */

import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { useSetAtom, useAtomValue } from 'jotai'
import App from './App'
import {
  themeModeAtom,
  systemIsDarkAtom,
  resolvedThemeAtom,
  applyThemeToDOM,
  initializeTheme,
} from './atoms/theme'
import {
  agentChannelIdAtom,
  agentModelIdAtom,
  agentWorkspacesAtom,
  currentAgentWorkspaceIdAtom,
  workspaceCapabilitiesVersionAtom,
  workspaceFilesVersionAtom,
} from './atoms/agent-atoms'
import { updateStatusAtom, initializeUpdater } from './atoms/updater'
import {
  notificationsEnabledAtom,
  initializeNotifications,
} from './atoms/notifications'
import { useGlobalAgentListeners } from './hooks/useGlobalAgentListeners'
import { Toaster } from './components/ui/sonner'
import { UpdateDialog } from './components/settings/UpdateDialog'
import './styles/globals.css'

/**
 * 主题初始化组件
 *
 * 负责从主进程加载主题设置、监听系统主题变化、
 * 并将最终主题同步到 DOM。
 */
function ThemeInitializer(): null {
  const setThemeMode = useSetAtom(themeModeAtom)
  const setSystemIsDark = useSetAtom(systemIsDarkAtom)
  const resolvedTheme = useAtomValue(resolvedThemeAtom)

  // 初始化：从主进程加载设置 + 订阅系统主题变化
  useEffect(() => {
    let isMounted = true
    let cleanup: (() => void) | undefined

    initializeTheme(setThemeMode, setSystemIsDark).then((fn) => {
      if (isMounted) {
        cleanup = fn
      } else {
        // 组件已卸载（StrictMode 场景），立即清理监听器
        fn()
      }
    })

    return () => {
      isMounted = false
      cleanup?.()
    }
  }, [setThemeMode, setSystemIsDark])

  // 响应式应用主题到 DOM
  useEffect(() => {
    applyThemeToDOM(resolvedTheme)
  }, [resolvedTheme])

  return null
}

/**
 * Agent 设置初始化组件
 *
 * 从主进程加载 Agent 渠道/模型设置并写入 atoms。
 */
function AgentSettingsInitializer(): null {
  const setAgentChannelId = useSetAtom(agentChannelIdAtom)
  const setAgentModelId = useSetAtom(agentModelIdAtom)
  const setAgentWorkspaces = useSetAtom(agentWorkspacesAtom)
  const setCurrentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  const bumpCapabilities = useSetAtom(workspaceCapabilitiesVersionAtom)
  const bumpFiles = useSetAtom(workspaceFilesVersionAtom)

  useEffect(() => {
    // 加载设置
    window.electronAPI.getSettings().then((settings) => {
      if (settings.agentChannelId) {
        setAgentChannelId(settings.agentChannelId)
      }
      if (settings.agentModelId) {
        setAgentModelId(settings.agentModelId)
      }

      // 加载工作区列表并恢复上次选中的工作区
      window.electronAPI.listAgentWorkspaces().then((workspaces) => {
        setAgentWorkspaces(workspaces)
        if (settings.agentWorkspaceId) {
          // 验证工作区仍然存在
          const exists = workspaces.some((w) => w.id === settings.agentWorkspaceId)
          setCurrentWorkspaceId(exists ? settings.agentWorkspaceId! : workspaces[0]?.id ?? null)
        } else if (workspaces.length > 0) {
          setCurrentWorkspaceId(workspaces[0]!.id)
        }
      }).catch(console.error)
    }).catch(console.error)
  }, [setAgentChannelId, setAgentModelId, setAgentWorkspaces, setCurrentWorkspaceId])

  // 订阅主进程文件监听推送
  useEffect(() => {
    const unsubCapabilities = window.electronAPI.onCapabilitiesChanged(() => {
      bumpCapabilities((v) => v + 1)
    })
    const unsubFiles = window.electronAPI.onWorkspaceFilesChanged(() => {
      bumpFiles((v) => v + 1)
    })

    return () => {
      unsubCapabilities()
      unsubFiles()
    }
  }, [bumpCapabilities, bumpFiles])

  return null
}

/**
 * 自动更新初始化组件
 *
 * 订阅主进程推送的更新状态变化事件。
 */
function UpdaterInitializer(): null {
  const setUpdateStatus = useSetAtom(updateStatusAtom)

  useEffect(() => {
    const cleanup = initializeUpdater(setUpdateStatus)
    return cleanup
  }, [setUpdateStatus])

  return null
}

/**
 * 通知初始化组件
 *
 * 从主进程加载通知开关设置。
 */
function NotificationsInitializer(): null {
  const setEnabled = useSetAtom(notificationsEnabledAtom)

  useEffect(() => {
    initializeNotifications(setEnabled)
  }, [setEnabled])

  return null
}

/**
 * Agent IPC 监听器初始化组件
 *
 * 全局挂载，永不销毁。确保 Agent 流式事件、权限请求
 * 在页面切换时不丢失。
 */
function AgentListenersInitializer(): null {
  useGlobalAgentListeners()
  return null
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeInitializer />
    <AgentSettingsInitializer />
    <NotificationsInitializer />
    <AgentListenersInitializer />
    <UpdaterInitializer />
    <App />
    <UpdateDialog />
    <Toaster position="top-right" />
  </React.StrictMode>
)
