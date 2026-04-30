/**
 * FileMentionSuggestion — TipTap Mention Suggestion 配置
 *
 * 工厂函数，创建用于 @ 引用文件的 TipTap Suggestion 配置。
 * 输入 @ 后异步搜索工作区文件，弹出 FileMentionList 浮动列表。
 */

import type React from 'react'
import { ReactRenderer } from '@tiptap/react'
import type { SuggestionOptions } from '@tiptap/suggestion'
import { FileMentionList } from './FileMentionList'
import type { FileMentionRef } from './FileMentionList'
import type { FileIndexEntry, FileSearchResult } from '@proma/shared'
import { createMentionPopup, positionPopup } from '@/components/agent/mention-popup-utils'

/**
 * 创建文件 @ 引用的 Suggestion 配置
 *
 * @param workspacePathRef 当前工作区根路径引用
 * @param mentionActiveRef 是否正在 mention 模式（用于阻止 Enter 发送消息）
 * @param attachedDirsRef 工作区级附加目录路径列表引用（标记为 workspace）
 * @param mentionItemCountRef mention 条目计数
 * @param sessionAttachedDirsRef 会话级附加目录路径列表引用（标记为 session）
 */
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

      return {
        onStart(props) {
          mentionActiveRef.current = true
          if (mentionItemCountRef) mentionItemCountRef.current = props.items.length

          try {
            const result = lastResult
            // 兼容旧版 IPC（未返回 sessionEntries/workspaceEntries）：从 entries 按 source 拆分
            let sessionEntries = result?.sessionEntries ?? []
            let workspaceEntries = result?.workspaceEntries ?? []
            if (sessionEntries.length === 0 && workspaceEntries.length === 0 && (result?.entries.length ?? 0) > 0) {
              const hasSource = result!.entries.some((e) => 'source' in e && e.source)
              if (hasSource) {
                sessionEntries = result!.entries.filter((e) => e.source === 'session')
                workspaceEntries = result!.entries.filter((e) => e.source === 'workspace')
              } else {
                // 旧版完全不返回 source，全部归入会话文件
                sessionEntries = result!.entries
              }
            }
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

            popup = createMentionPopup(renderer.element)
            positionPopup(popup, props.clientRect?.())
          } catch (e) {
            console.error('[FileMention] render popup failed:', e)
          }
        },

        onUpdate(props) {
          if (mentionItemCountRef) mentionItemCountRef.current = props.items.length

          const result = lastResult
          let sessionEntries = result?.sessionEntries ?? []
          let workspaceEntries = result?.workspaceEntries ?? []
          if (sessionEntries.length === 0 && workspaceEntries.length === 0 && (result?.entries.length ?? 0) > 0) {
            sessionEntries = result!.entries.filter((e) => e.source === 'session')
            workspaceEntries = result!.entries.filter((e) => e.source === 'workspace')
          }
          renderer?.updateProps({
            sessionEntries,
            workspaceEntries,
            onSelect: (item: { name: string; path: string; type: 'file' | 'dir' }) => {
              props.command({ id: item.path, label: item.name })
            },
          })
          positionPopup(popup, props.clientRect?.())
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
          popup?.remove()
          popup = null
          renderer?.destroy()
          renderer = null
        },
      }
    },
  }
}
