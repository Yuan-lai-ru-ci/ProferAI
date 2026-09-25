/**
 * useOpenPreview — 统一的文件预览入口（Tab 化）
 *
 * 文件链接统一开成会话绑定的预览 Tab：每文件一个 Tab，内容统一由
 * DiffTabContent 渲染（长尾/静态图格式经其内置 OfvPreview 回退覆盖）。
 *
 * 历史路由（浏览器列内预览 / 主进程 OFV viewer 页）已退役：
 * - BrowserInlinePreview 与 browserInlinePreviewMapAtom 随之删除；
 * - openFileInBrowser IPC 与 viewer.html 保留在主进程，仅供浏览器自身打开本地文件，
 *   renderer 文件预览不再走这条路。
 */

import * as React from 'react'
import { getDefaultStore, useStore } from 'jotai'
import { previewFileMapAtom, previewFilesByTabAtom, type PreviewFile } from '@/atoms/preview-atoms'
import { agentSessionPathMapAtom } from '@/atoms/agent-atoms'
import { isAbsoluteFilePath } from '@/lib/file-utils'
import {
  activeTabIdAtom,
  createPreviewTabId,
  getPreviewTabTitle,
  openTab,
  tabsAtom,
} from '@/atoms/tab-atoms'

/** Jotai store 类型（从 useStore 推导，避免直接 import 内部 Store 类型） */
type JotaiStore = ReturnType<typeof useStore>

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

/**
 * 打开（或聚焦）一个文件预览 Tab。所有文件预览的唯一入口：
 * - 归一化路径，更新会话「最近文件」指针（高亮/聚焦刷新/PPTX 回执使用）；
 * - 写入该 Tab 的完整 PreviewFile 元数据（PreviewTabContent 按 tabId 读取）；
 * - 每文件一个 Tab，重复打开同一文件 = 聚焦既有 Tab（元数据仍会刷新）。
 *
 * activate 默认 true；后台打开（如自动预览推送）传 false，由调用方决定是否并排组合。
 */
export function openFilePreviewTab(
  store: JotaiStore,
  sessionId: string,
  file: PreviewFile,
  options: { activate?: boolean } = {},
): string {
  const normalizedFile = normalizePreviewFile(store, sessionId, file)
  store.set(previewFileMapAtom, (prev) => {
    const m = new Map(prev)
    m.set(sessionId, normalizedFile)
    return m
  })
  const tabId = createPreviewTabId(sessionId, normalizedFile.filePath)
  store.set(previewFilesByTabAtom, (prev) => {
    const m = new Map(prev)
    m.set(tabId, normalizedFile)
    return m
  })
  if (!store.get(tabsAtom).some((tab) => tab.id === tabId)) {
    const result = openTab(store.get(tabsAtom), {
      type: 'preview',
      sessionId,
      title: getPreviewTabTitle(normalizedFile.filePath),
      filePath: normalizedFile.filePath,
    })
    store.set(tabsAtom, result.tabs)
  }
  if (options.activate !== false) {
    store.set(activeTabIdAtom, tabId)
  }
  return tabId
}

/** 模块级入口（与 usePanelAutoLayout 的模块级函数同一模式），供非 React 上下文调用。 */
export function openFilePreviewTabForSession(sessionId: string, file: PreviewFile, options?: { activate?: boolean }): string {
  return openFilePreviewTab(getDefaultStore(), sessionId, file, options)
}

export function useOpenPreview() {
  const store = useStore()

  return React.useCallback(
    (sessionId: string, file: PreviewFile) => {
      openFilePreviewTab(store, sessionId, file)
    },
    [store],
  )
}
