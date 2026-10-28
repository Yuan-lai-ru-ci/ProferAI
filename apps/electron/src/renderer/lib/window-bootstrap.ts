/**
 * 主应用窗口引导。
 *
 * 会话窗口通过主进程注册表读取初始 Tab 快照（尤其是拆窗时带过来的输入草稿）；
 * 主窗口只需要知道自己是 main，不再依赖 Tab 的跨窗口持久化。
 */

import type { MainWindowBootstrap } from '@profer/shared'

let bootstrapPromise: Promise<MainWindowBootstrap> | null = null

function fallbackBootstrap(): MainWindowBootstrap {
  const isSessionWindow = new URLSearchParams(window.location.search).get('window') === 'session'
  return {
    windowId: isSessionWindow ? 'session' : 'primary',
    kind: isSessionWindow ? 'session' : 'main',
    isPrimary: !isSessionWindow,
    initialTab: null,
  }
}

/** 读取窗口引导（进程内只请求一次）。失败时按窗口 URL 回退，不阻断启动。 */
export function getWindowBootstrap(): Promise<MainWindowBootstrap> {
  if (!bootstrapPromise) {
    const request = window.electronAPI.getWindowBootstrap
    if (typeof request !== 'function') {
      bootstrapPromise = Promise.resolve(fallbackBootstrap())
      return bootstrapPromise
    }
    bootstrapPromise = request()
      .catch((error) => {
        console.error('[WindowBootstrap] 读取窗口引导失败，按窗口 URL 回退:', error)
        return fallbackBootstrap()
      })
  }
  return bootstrapPromise
}
