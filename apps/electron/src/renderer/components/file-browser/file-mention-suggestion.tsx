/**
 * FileMentionSuggestion — TipTap Mention Suggestion 配置
 *
 * 工厂函数，创建用于 @ 引用文件的 TipTap Suggestion 配置。
 * 输入 @ 后异步搜索工作区文件，弹出 FileMentionList 浮动列表。
 * 弹窗底部锚定在光标上方，展开文件夹时向上生长。
 */

import type React from 'react'
import { ReactRenderer } from '@tiptap/react'
import type { SuggestionOptions } from '@tiptap/suggestion'
import { FileMentionList } from './FileMentionList'
import type { FileMentionRef } from './FileMentionList'
import type { FileIndexEntry, FileSearchResult } from '@proma/shared'
import { createMentionPopup, positionPopup } from '@/components/agent/mention-popup-utils'

export function createFileMentionSuggestion(
  workspacePathRef: React.RefObject<string | null>,
  mentionActiveRef: React.MutableRefObject<boolean>,
  attachedDirsRef?: React.RefObject<string[]>,
  mentionItemCountRef?: React.MutableRefObject<number>,
  sessionAttachedDirsRef?: React.RefObject<string[]>,
): Omit<SuggestionOptions<FileIndexEntry>, 'editor'> {
  let lastResult: FileSearchResult | null = null

  return {
    char: '@',
    allowSpaces: false,

    items: async ({ query }): Promise<FileIndexEntry[]> => {
      const wsPath = workspacePathRef.current
      if (!wsPath) {
        console.warn('[FileMention] workspacePath is null, mention disabled')
        return []
      }

      try {
        const additionalPaths = attachedDirsRef?.current ?? []
        const sessionPaths = sessionAttachedDirsRef?.current ?? []

        console.log('[FileMention] searching files, query:', JSON.stringify(query), 'ws:', wsPath, 'additionalPaths:', additionalPaths, 'sessionPaths:', sessionPaths)
        const result = await window.electronAPI.searchWorkspaceFiles(
          wsPath,
          query ?? '',
          20,
          additionalPaths.length > 0 ? additionalPaths : undefined,
          sessionPaths.length > 0 ? sessionPaths : undefined,
        )
        console.log('[FileMention] search result:', { total: result.total, sessionCount: result.sessionEntries.length, workspaceCount: result.workspaceEntries.length })
        lastResult = result
        return result.entries
      } catch(e) {
        console.error('[FileMention] search failed:', e)
        lastResult = null
        return []
      }
    },

    render: () => {
      let renderer: ReactRenderer<FileMentionRef> | null = null
      let popup: HTMLDivElement | null = null
      let resizeObserver: ResizeObserver | null = null

      function splitEntries(result: FileSearchResult | null) {
        let sessionEntries = result?.sessionEntries ?? []
        let workspaceEntries = result?.workspaceEntries ?? []
        if (sessionEntries.length === 0 && workspaceEntries.length === 0 && (result?.entries.length ?? 0) > 0) {
          const hasSource = result!.entries.some((e) => 'source' in e && e.source)
          if (hasSource) {
            sessionEntries = result!.entries.filter((e) => e.source === 'session')
            workspaceEntries = result!.entries.filter((e) => e.source === 'workspace')
          } else {
            sessionEntries = result!.entries
          }
        }
        return { sessionEntries, workspaceEntries }
      }

      function createRenderer(props: any) {
        const { sessionEntries, workspaceEntries } = splitEntries(lastResult)
        renderer = new ReactRenderer(FileMentionList, {
          props: {
            sessionEntries,
            workspaceEntries,
            onSelect: (item: { name: string; path: string; type: 'file' | 'dir' }) => {
              props.command({ id: item.path, label: item.name })
            },
          },
          editor: props.editor,
        })
      }

      function anchorPopup(rect?: (() => DOMRect | null) | null) {
        if (!popup) return
        positionPopup(popup, rect?.(), { anchorBottom: true })
      }

      return {
        onStart(props) {
          mentionActiveRef.current = true
          if (mentionItemCountRef) mentionItemCountRef.current = props.items.length

          try {
            createRenderer(props)
            popup = createMentionPopup(renderer!.element)
            anchorPopup(props.clientRect)

            // 监听弹窗高度变化（展开/折叠文件夹时），重新定位保持底部锚定
            resizeObserver = new ResizeObserver(() => {
              anchorPopup(props.clientRect)
            })
            resizeObserver.observe(popup!)
          } catch (e) {
            console.error('[FileMention] render popup failed:', e)
          }
        },

        onUpdate(props) {
          if (mentionItemCountRef) mentionItemCountRef.current = props.items.length

          const { sessionEntries, workspaceEntries } = splitEntries(lastResult)
          renderer?.updateProps({
            sessionEntries,
            workspaceEntries,
            onSelect: (item: { name: string; path: string; type: 'file' | 'dir' }) => {
              props.command({ id: item.path, label: item.name })
            },
          })
          anchorPopup(props.clientRect)
        },

        onKeyDown(props) {
          if (renderer?.ref) {
            return renderer.ref.onKeyDown({ event: props.event })
          }
          return false
        },

        onExit() {
          mentionActiveRef.current = false
          if (mentionItemCountRef) mentionItemCountRef.current = 0
          lastResult = null
          resizeObserver?.disconnect()
          resizeObserver = null
          popup?.remove()
          popup = null
          renderer?.destroy()
          renderer = null
        },
      }
    },
  }
}
