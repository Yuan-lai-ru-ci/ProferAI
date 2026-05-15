/**
 * ScratchPadView — 草稿本编辑器
 *
 * 基于 TipTap 的轻量 Markdown 编辑器，内容持久化到 ~/.proma/scratch-pad.md。
 * 自动保存由 ScratchPadPersistence 组件通过监听 scratchPadContentAtom 统一管理。
 */

import * as React from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import MarkdownIt from 'markdown-it'
import TurndownService from 'turndown'
import { useAtom, useAtomValue } from 'jotai'
import { FileDown } from 'lucide-react'
import { scratchPadContentAtom, scratchPadLoadedAtom, tabsAtom, activeTabIdAtom } from '@/atoms/tab-atoms'
import { currentAgentWorkspaceIdAtom, agentWorkspacesAtom } from '@/atoms/agent-atoms'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

const md = new MarkdownIt({ breaks: true, linkify: true })
const turndown = new TurndownService()

export function ScratchPadView(): React.ReactElement {
  const [content, setContent] = useAtom(scratchPadContentAtom)
  const loaded = useAtomValue(scratchPadLoadedAtom)
  const containerRef = React.useRef<HTMLDivElement>(null)

  // 用 ref 追踪最新内容，避免在 useEffect deps 里包含 content 导致循环
  const contentRef = React.useRef(content)
  contentRef.current = content

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({
        placeholder: '在此随意书写… 支持 Markdown 快捷输入',
      }),
    ],
    content: content || '',
    onUpdate: ({ editor }) => {
      setContent(editor.getHTML())
    },
    immediatelyRender: false,
  })

  // 导出目标上下文
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)

  const currentWorkspace = React.useMemo(
    () => workspaces.find((w) => w.id === currentWorkspaceId) ?? null,
    [workspaces, currentWorkspaceId],
  )

  const activeSessionId = React.useMemo(() => {
    const activeTab = tabs.find((t) => t.id === activeTabId)
    if (activeTab?.type === 'agent') return activeTab.sessionId
    const agentTab = [...tabs].reverse().find((t) => t.type === 'agent')
    return agentTab?.sessionId ?? null
  }, [tabs, activeTabId])

  const activeSessionTitle = React.useMemo(() => {
    const agentTab = tabs.find((t) => t.sessionId === activeSessionId && t.type === 'agent')
    return agentTab?.title ?? null
  }, [tabs, activeSessionId])

  const makeFilename = () => {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `scratch-pad-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.md`
  }

  const handleExport = React.useCallback(
    async (target: 'session' | 'workspace') => {
      if (!editor) return
      const html = editor.getHTML()
      if (!html || html === '<p></p>') return

      const markdownContent = turndown.turndown(html)
      const filename = makeFilename()

      try {
        let dirPath: string | null = null
        if (target === 'session' && activeSessionId && currentWorkspaceId) {
          dirPath = await window.electronAPI.getAgentSessionPath(currentWorkspaceId, activeSessionId)
        } else if (target === 'workspace' && currentWorkspace?.slug) {
          dirPath = await window.electronAPI.getWorkspaceFilesPath(currentWorkspace.slug)
        }
        if (!dirPath) return
        await window.electronAPI.exportScratchPad(markdownContent, dirPath, filename)
      } catch (err) {
        console.error('[ScratchPad] 导出失败:', err)
      }
    },
    [editor, activeSessionId, currentWorkspaceId, currentWorkspace],
  )

  const handleBrowseExport = React.useCallback(async () => {
    if (!editor) return
    const html = editor.getHTML()
    if (!html || html === '<p></p>') return

    const filename = makeFilename()
    const filePath = await window.electronAPI.chooseExportPath(filename)
    if (!filePath) return

    try {
      const markdownContent = turndown.turndown(html)
      // 从完整路径中分离目录和文件名
      const sep = filePath.includes('\\') ? '\\' : '/'
      const lastSep = filePath.lastIndexOf(sep)
      const dirPath = filePath.slice(0, lastSep)
      const chosenFilename = filePath.slice(lastSep + 1)
      await window.electronAPI.exportScratchPad(markdownContent, dirPath, chosenFilename)
    } catch (err) {
      console.error('[ScratchPad] 导出失败:', err)
    }
  }, [editor])

  // 仅在初始加载或编辑器重新挂载时同步内容到编辑器。
  // content 不加入 deps：用户每次输入都会更新 atom，若加入 deps 会导致
  // setContent → onUpdate → atom 变化 → setContent 死循环，
  // HTML 规范化解析会吞掉尾部空格和空段落，并重置光标位置。
  React.useEffect(() => {
    if (!loaded || !editor) return
    const latestContent = contentRef.current
    if (latestContent && editor.getHTML() !== latestContent) {
      editor.commands.setContent(latestContent)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, editor])

  // 粘贴时自动将 Markdown 转为 HTML 插入
  React.useEffect(() => {
    const el = containerRef.current
    if (!el || !editor) return

    const handlePaste = (e: ClipboardEvent): void => {
      const text = e.clipboardData?.getData('text/plain')
      if (!text) return
      if (!/[#*>\-`[\]~|]/.test(text)) return

      e.preventDefault()
      e.stopPropagation()
      try {
        const html = md.render(text)
        editor.chain().focus().insertContent(html).run()
      } catch {
        // 转换失败，回退到纯文本插入
        editor.chain().focus().insertContent(text).run()
      }
    }

    el.addEventListener('paste', handlePaste, true)
    return () => el.removeEventListener('paste', handlePaste, true)
  }, [editor])

  return (
    <div ref={containerRef} className="flex flex-col h-full">
      <div className="flex-1 overflow-auto scrollbar-thin px-8 py-6">
        <div className="max-w-3xl mx-auto h-full">
          {loaded ? (
            <EditorContent
              editor={editor}
              className="prose prose-sm dark:prose-invert max-w-none h-full [&_.ProseMirror]:min-h-full [&_.ProseMirror]:outline-none [&_.ProseMirror]:text-sm [&_.ProseMirror_p.is-editor-empty:first-child::before]:text-muted-foreground/50 [&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left [&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none [&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0"
            />
          ) : (
            <div className="min-h-[200px] flex items-center justify-center">
              <span className="text-sm text-muted-foreground/40">加载中…</span>
            </div>
          )}
        </div>
      </div>
      <div className="h-[28px] border-t border-border/40 px-4 flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground/60">
          Scratch Pad — 内容自动保存到本地
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="text-[11px] text-muted-foreground/60 hover:text-foreground flex items-center gap-1 transition-colors"
              title="导出为 Markdown"
            >
              <FileDown className="w-3 h-3" />
              导出
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
          <DropdownMenuContent align="end" side="top" className="min-w-[240px] z-[9999]">
            <DropdownMenuLabel className="text-[11px] text-muted-foreground font-normal">
              导出为 Markdown
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => handleExport('session')}
              disabled={!activeSessionId}
              className="flex flex-col items-start"
            >
              <span className="text-xs">保存到会话目录</span>
              <span className="text-[10px] text-muted-foreground">
                {activeSessionTitle ?? '无活跃会话'}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => handleExport('workspace')}
              disabled={!currentWorkspace}
              className="flex flex-col items-start"
            >
              <span className="text-xs">保存到工作区目录</span>
              <span className="text-[10px] text-muted-foreground">
                {currentWorkspace?.name ?? '无当前工作区'}
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={handleBrowseExport}>
              浏览选择位置...
            </DropdownMenuItem>
          </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenu>
      </div>
    </div>
  )
}
