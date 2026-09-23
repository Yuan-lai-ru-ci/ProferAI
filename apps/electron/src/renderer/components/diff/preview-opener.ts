/**
 * useOpenPreview — 统一的预览入口 Hook
 *
 * 文件链接默认统一进入右侧 Browser：长尾格式走 Open File Viewer，其他格式走 BrowserInlinePreview。
 * BrowserInlinePreview 仍提供“在标签页中打开”的手动逃生口，但不再由文件链接默认路由触发。
 */

import * as React from 'react'
import { getDefaultStore, useStore } from 'jotai'
import { toast } from 'sonner'
import {
  previewFileMapAtom,
  previewPanelOpenMapAtom,
  type PreviewFile,
} from '@/atoms/preview-atoms'
import { agentSessionPathMapAtom, currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { browserInlinePreviewMapAtom, browserPanelDismissedSessionIdsAtom, browserPanelOpenMapAtom, browserStateMapAtom } from '@/atoms/browser-atoms'
import { activeSkinIdAtom, resolvedThemeAtom, whenSkinCssApplied } from '@/atoms/theme'
import { readOfvThemeTokens } from '@/lib/ofv-theme-tokens'
import { openBrowserFromPush } from '@/hooks/usePanelAutoLayout'
import { resolvePreviewDestination } from '@/lib/preview-destination'
import { isAbsoluteFilePath } from '@/lib/file-utils'
import {
  activeTabIdAtom,
  closeTab,
  getPreviewTabTitle,
  isPreviewTab,
  openTab,
  sessionViewStateMapAtom,
  tabMruAtom,
  tabsAtom,
} from '@/atoms/tab-atoms'

/** Jotai store 类型（从 useStore 推导，避免直接 import 内部 Store 类型） */
type JotaiStore = ReturnType<typeof useStore>

const browserPreviewRequestVersions = new Map<string, number>()

function beginBrowserPreviewRequest(sessionId: string): number {
  const next = (browserPreviewRequestVersions.get(sessionId) ?? 0) + 1
  browserPreviewRequestVersions.set(sessionId, next)
  return next
}

function isCurrentBrowserPreviewRequest(
  sessionId: string,
  requestVersion: number,
  store: JotaiStore,
): boolean {
  return browserPreviewRequestVersions.get(sessionId) === requestVersion
    && store.get(currentAgentSessionIdAtom) === sessionId
}

function normalizePreviewPath(filePath: string): string {
  if (!/^[A-Za-z]:[\\/]/.test(filePath)) return filePath
  const normalized = filePath
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]:)\/+/, '$1/')
  return normalized.replace(
    /^([A-Za-z]:\/Users\/[^/]+)\.(profer(?:-dev)?|proma(?:-dev)?)(?=\/|$)/i,
    '$1/.$2',
  )
}

function joinPreviewPath(basePath: string, filePath: string): string {
  return normalizePreviewPath(`${basePath.replace(/[\\/]+$/, '')}/${filePath.replace(/^[\\/]+/, '')}`)
}

/** 将所有预览入口的相对路径归一为真实绝对路径，保证默认应用探测使用同一目标。 */
function normalizePreviewFile(store: JotaiStore, sessionId: string, file: PreviewFile): PreviewFile {
  if (isAbsoluteFilePath(file.filePath)) {
    const filePath = normalizePreviewPath(file.filePath)
    return filePath === file.filePath ? file : { ...file, filePath }
  }

  const sessionPath = store.get(agentSessionPathMapAtom).get(sessionId) ?? ''
  const basePath = file.basePaths?.find(Boolean) ?? file.dirPath ?? sessionPath
  if (!basePath || !file.filePath) return file

  return {
    ...file,
    filePath: joinPreviewPath(basePath, file.filePath),
    dirPath: file.dirPath ?? basePath,
  }
}

export function useOpenPreview() {
  const store = useStore()

  return React.useCallback(
    (sessionId: string, file: PreviewFile) => {
      const normalizedFile = normalizePreviewFile(store, sessionId, file)
      // 1. 文件状态两种模式都需要，先写入
      store.set(previewFileMapAtom, (prev) => {
        const m = new Map(prev)
        m.set(sessionId, normalizedFile)
        return m
      })

      // 目的地判定集中在一个纯函数里（`lib/preview-destination`，可逐格式单测）：
      // OFV viewer 或 Browser 列内预览。文件链接不再根据 Tab / 分屏偏好进入旧预览面板。
      const requestVersion = beginBrowserPreviewRequest(sessionId)
      const destination = resolvePreviewDestination(normalizedFile.filePath)
      if (destination === 'ofv-viewer') {
        openOfvFileInBrowser(store, sessionId, normalizedFile.filePath, requestVersion)
        return
      }
      if (destination === 'browser-inline') {
        openBrowserInlinePreview(store, sessionId, normalizedFile)
        return
      }

      // resolvePreviewDestination 当前只返回 Browser 路由；保留显式失败保护，
      // 防止未来新增目的地时静默回落到旧的 Tab/面板行为。
      console.warn(`[preview] 未处理的预览目的地: ${destination}`)
      openBrowserInlinePreview(store, sessionId, normalizedFile)
    },
    [store],
  )
}

/**
 * tearOffPreviewToSplit — 把 preview Tab 即时切换为右侧分屏。
 *
 * 用于「拖拽 preview Tab 出 TabBar」与「PreviewTabContent 顶栏切换按钮」两条入口共用。
 * 流程：关闭 preview Tab → 激活对应会话的 agent Tab → 开启右侧分屏。
 * previewFileMap 中保留的文件就是分屏要显示的内容，无需重新打开。
 *
 * 若传入的 tabId 不是 preview Tab、已找不到，或该会话没有可承载分屏的 agent Tab，则不做任何事。
 */
export function tearOffPreviewToSplit(store: JotaiStore, tabId: string): void {
  const tabs = store.get(tabsAtom)
  const tab = tabs.find((t) => t.id === tabId)
  if (!tab || !isPreviewTab(tab)) return

  const sessionId = tab.sessionId

  // 分屏渲染在该会话的 agent 视图内，若没有对应 agent Tab 则无处承载，保持 Tab 模式不动
  const agentTab = tabs.find((t) => t.type === 'agent' && t.sessionId === sessionId)
  if (!agentTab) return

  closeBrowserPreviewSurface(store, sessionId)

  // 关闭 preview Tab，并激活该会话的 agent Tab，让右侧分屏可见
  const closed = closeTab(store.get(tabsAtom), store.get(activeTabIdAtom), tabId, store.get(tabMruAtom))
  store.set(tabsAtom, closed.tabs)
  store.set(activeTabIdAtom, agentTab.id)
  store.set(tabMruAtom, closed.mru)

  // 标记会话视图为 session，避免切走再切回时重建 preview Tab
  store.set(sessionViewStateMapAtom, (prev) => {
    const m = new Map(prev)
    m.set(sessionId, { previewTabOpen: false, lastView: 'session' })
    return m
  })

  // 开启右侧分屏
  store.set(previewPanelOpenMapAtom, (prev) => {
    const m = new Map(prev)
    m.set(sessionId, true)
    return m
  })
}

/**
 * 关闭某会话的内联预览分屏（该文件已经在组合的一栏里显示时调用）。
 *
 * 为什么需要：组合成员与内联分屏表达的是同一件事（"把这个文件摊开看"），
 * 两处同时显示会让用户以为出现了重复面板；而且焦点落在预览标签上时，
 * 内联分屏本来就会因为 activeTab 不是 agent 而隐藏，留着它只会让焦点来回切换时布局跳动。
 *
 * 模块级函数（与 usePanelAutoLayout 的 openFilePanel / openBrowserFromPush 同一模式），
 * 供非组件上下文调用。
 */
export function closeInlinePreview(sessionId: string): void {
  closePreviewPanelForSession(getDefaultStore(), sessionId)
}

function closePreviewPanelForSession(store: JotaiStore, sessionId: string): void {
  store.set(previewPanelOpenMapAtom, (prev) => {
    if (prev.get(sessionId) !== true) return prev
    const next = new Map(prev)
    next.set(sessionId, false)
    return next
  })
}

function closeBrowserPanelForSession(store: JotaiStore, sessionId: string): void {
  store.set(browserPanelOpenMapAtom, (prev) => {
    if (prev.get(sessionId) !== true) return prev
    const next = new Map(prev)
    next.set(sessionId, false)
    return next
  })
}

function dismissBrowserPanelForSession(store: JotaiStore, sessionId: string): void {
  closeBrowserPanelForSession(store, sessionId)
  store.set(browserPanelDismissedSessionIdsAtom, (prev) => {
    if (prev.has(sessionId)) return prev
    const next = new Set(prev)
    next.add(sessionId)
    return next
  })
}

function clearBrowserInlinePreviewForSession(store: JotaiStore, sessionId: string): void {
  store.set(browserInlinePreviewMapAtom, (prev) => {
    if (!prev.has(sessionId)) return prev
    const next = new Map(prev)
    next.delete(sessionId)
    return next
  })
}

function closeBrowserPreviewSurface(store: JotaiStore, sessionId: string): void {
  dismissBrowserPanelForSession(store, sessionId)
  clearBrowserInlinePreviewForSession(store, sessionId)
}

/**
 * 把一个 OFV 承担的文件交给受管浏览器列。
 *
 * 三件事必须一起做，否则表现为"点了没反应"：
 * 1. 置展开意图（browserPanelOpenMap）—— MainArea 据此渲染浏览器卡片；
 * 2. 清掉该会话的 dismissed 标记 —— 用户此前手动关过浏览器时，它会被 autoOpen 守卫挡掉；
 * 3. 走 openBrowserFromPush 做可见性判定 —— 窗口宽度不足时只保留意图 + toast，与既有行为一致。
 *
 * 之后由主进程 `OPEN_FILE_IN_BROWSER` → `browserController.previewOpen` 把文件加载进浏览器
 * （非 HTML 走内置 viewer 页，文件以 token URL 传入，主题随 theme + tokens 烘进 URL）。
 */
function openOfvFileInBrowser(store: JotaiStore, sessionId: string, filePath: string, requestVersion: number): void {
  // 浏览器列接管当前文件预览时，先撤掉旧面板/列内模式，避免关闭浏览器后又回到旧文件。
  closePreviewPanelForSession(store, sessionId)
  clearBrowserInlinePreviewForSession(store, sessionId)
  store.set(browserPanelOpenMapAtom, (prev) => {
    if (prev.get(sessionId) === true) return prev
    const next = new Map(prev)
    next.set(sessionId, true)
    return next
  })
  store.set(browserPanelDismissedSessionIdsAtom, (prev) => {
    if (!prev.has(sessionId)) return prev
    const next = new Set(prev)
    next.delete(sessionId)
    return next
  })
  openBrowserFromPush(sessionId)
  void (async () => {
    // 换肤后立即点文件时，皮肤 CSS 可能还在注入途中；等它落定再取值，
    // 否则会把上一个皮肤的颜色烘进这次预览的 URL 里。
    await whenSkinCssApplied(store.get(activeSkinIdAtom))
    if (!isCurrentBrowserPreviewRequest(sessionId, requestVersion, store)) return
    await window.electronAPI.openFileInBrowser({
      sessionId,
      filePath,
      theme: store.get(resolvedThemeAtom),
      tokens: readOfvThemeTokens(),
    })
  })().catch((error: unknown) => {
    if (!isCurrentBrowserPreviewRequest(sessionId, requestVersion, store)) return
    closeBrowserPanelForSession(store, sessionId)
    toast.error('文件预览打开失败', { description: error instanceof Error ? error.message : '无法加载该文件' })
    console.error('[preview] 在受管浏览器里打开文件失败:', error)
  })
}

/**
 * 把一个文件交给**浏览器列的列内模式**（文本/代码兑底 + 静态图；不经 OFV 也不开新页面）。
 *
 * 三件事与 OFV 那条路一致：置展开意图 / 清掉 dismissed 标记 / 走 openBrowserFromPush 判可见性。
 * 区别在于内容完全由渲染进程渲染（复用预览面板的 DiffTabContent），主进程无感 ——
 * 所以这里不需要任何 IPC，只是把条目写进 atom，列里那条地毯就会盖上去。
 */
function openBrowserInlinePreview(store: JotaiStore, sessionId: string, file: PreviewFile): void {
  // 列内预览与旧的右侧预览面板互斥；否则浏览器虽然打开，关闭后会回放旧面板。
  closePreviewPanelForSession(store, sessionId)
  store.set(browserInlinePreviewMapAtom, (prev) => {
    const next = new Map(prev)
    next.set(sessionId, file)
    return next
  })
  store.set(browserPanelDismissedSessionIdsAtom, (prev) => {
    if (!prev.has(sessionId)) return prev
    const next = new Set(prev)
    next.delete(sessionId)
    return next
  })
  openBrowserFromPush(sessionId)
}

/**
 * 退出列内文件预览，回到浏览器内容。
 * 模块级（与 `closeInlinePreview` 同一模式），供列内点标签、新建标签、导航等非 React 上下文调用。
 * 文件本身不丢：`previewFileMapAtom` 还留着，用户仍可在预览面板/标签里打开它。
 */
export function clearBrowserInlinePreview(sessionId: string): void {
  clearBrowserInlinePreviewForSession(getDefaultStore(), sessionId)
}

export function closeBrowserInlinePreview(sessionId: string): void {
  const store = getDefaultStore()
  clearBrowserInlinePreviewForSession(store, sessionId)
  // 列内预览可以先于主进程浏览器会话出现；显式关闭它时不要留下没有 state 的空浏览器壳。
  if (!store.get(browserStateMapAtom).has(sessionId)) closeBrowserPanelForSession(store, sessionId)
}

/**
 * 把一个文件开成预览 Tab（关掉分屏，保持面板打开态一致）。
 * 从 `useOpenPreview` 的 Tab 分支抽出，供列内预览的「在标签页中打开」逃生口复用。
 */
export function openPreviewTab(store: JotaiStore, sessionId: string, filePath: string): void {
  dismissBrowserPanelForSession(store, sessionId)
  clearBrowserInlinePreviewForSession(store, sessionId)
  store.set(previewPanelOpenMapAtom, (prev) => {
    const m = new Map(prev)
    m.set(sessionId, false)
    return m
  })
  const result = openTab(store.get(tabsAtom), {
    type: 'preview',
    sessionId,
    title: getPreviewTabTitle(filePath),
  })
  store.set(tabsAtom, result.tabs)
  store.set(activeTabIdAtom, result.activeTabId)
}
