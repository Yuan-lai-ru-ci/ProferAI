/**
 * ScratchPadView — 草稿本编辑器
 *
 * 基于 TipTap 的轻量 Markdown 编辑器，内容持久化到 ~/.profer/scratch-pad.md。
 * 自动保存由 ScratchPadPersistence 组件通过监听 scratchPadContentAtom 统一管理。
 *
 * 支持：Markdown 快捷输入、图片粘贴、Todo 列表（- [ ] 触发）、代码高亮（lowlight）、数学公式（$..$ / $$..$$ 触发）、导出为 Markdown
 */

import * as React from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import { useAtom, useAtomValue } from 'jotai'
import { FileDown, ImagePlus } from 'lucide-react'
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
} from '@profer/ui/primitives/dropdown-menu'
import { lowlight } from '@/lib/lowlight'
import { htmlToMarkdown, markdownToHtml } from '@/lib/markdown-rich-text'
import {
  MathBlock,
  MathInline,
  RawHtmlBlock,
  RawHtmlInline,
  TaskItem,
  TaskList,
  tableExtensions,
  createMarkdownImage,
  createMarkdownVideo,
} from '@/components/diff/markdown-preview-extensions'
import { SpeechButton } from '@/components/ai-elements/speech-button'
import { MarkdownEditorToolbar } from '@/components/diff/MarkdownEditorToolbar'
import {
  SCRATCH_PAD_VOICE_INPUT_ID,
  VOICE_DICTATION_INSERT_EVENT,
  getLastFocusedVoiceInputId,
  setLastFocusedVoiceInputId,
} from '@/lib/voice-input-focus'

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsText(file)
  })
}

function isMarkdownFile(file: File): boolean {
  return /\.(md|markdown|mdown|mkdn)$/i.test(file.name)
}

export function ScratchPadView(): React.ReactElement {
  const [content, setContent] = useAtom(scratchPadContentAtom)
  const loaded = useAtomValue(scratchPadLoadedAtom)
  const [isDragging, setIsDragging] = React.useState(false)
  const containerRef = React.useRef<HTMLDivElement>(null)

  const extensions = React.useMemo(() => [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      codeBlock: false,
      link: false,
      underline: false,
    }),
    Placeholder.configure({
      placeholder: '在此随意书写… 支持 Markdown 快捷输入',
    }),
    CodeBlockLowlight.configure({ lowlight }),
    Underline,
    Link.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      validate: (href) => /^(https?|mailto|file|profer-file):/.test(href),
    }),
    // ScratchPad 无会话/文件上下文，传 null 跳过路径解析（仅支持 data-URL / 外链 / file: 协议）
    createMarkdownImage(null),
    createMarkdownVideo(null),
    RawHtmlBlock,
    RawHtmlInline,
    MathBlock,
    MathInline,
    TaskList,
    TaskItem,
    ...tableExtensions,
  ], [])

  const editor = useEditor({
    extensions,
    content: content || '',
    onUpdate: ({ editor }) => {
      setContent(editor.getHTML())
    },
    immediatelyRender: false,
  })

  const loadedContentAppliedRef = React.useRef(false)
  React.useEffect(() => {
    if (!editor || !loaded || loadedContentAppliedRef.current) return
    editor.commands.setContent(content || '', { emitUpdate: false })
    loadedContentAppliedRef.current = true
  }, [editor, loaded, content])

  // ===== 文件中转 =====

  const insertFile = React.useCallback(async (file: File): Promise<void> => {
    if (!editor) return
    try {
      if (file.type.startsWith('image/')) {
        const src = await readFileAsDataUrl(file)
        editor.chain().focus().insertContent({
          type: 'markdownImage',
          attrs: { src, alt: file.name.replace(/\.[^.]+$/, ''), title: file.name },
        }).run()
        return
      }

      const text = await readFileAsText(file)
      if (!text) return
      const html = isMarkdownFile(file) ? markdownToHtml(text) : undefined
      editor.chain().focus().insertContent(html ?? text).run()
    } catch (err) {
      console.error('[ScratchPad] 文件插入失败:', err)
    }
  }, [editor])

  const handleDragOver = React.useCallback((event: React.DragEvent<HTMLDivElement>): void => {
    if (event.dataTransfer.types.includes('Files')) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      setIsDragging(true)
    }
  }, [])

  const handleDragLeave = React.useCallback((event: React.DragEvent<HTMLDivElement>): void => {
    if (event.currentTarget === event.target || !event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsDragging(false)
    }
  }, [])

  const handleDrop = React.useCallback((event: React.DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.files.length) return
    event.preventDefault()
    setIsDragging(false)
    const files = Array.from(event.dataTransfer.files)
    void (async () => {
      for (const file of files) await insertFile(file)
    })()
  }, [insertFile])

  // ===== 导出 =====

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
    if (activeTab?.type === 'agent' || activeTab?.type === 'preview' || activeTab?.type === 'browser') return activeTab.sessionId
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
      if (!editor || editor.isEmpty) return
      // htmlToMarkdown 能正确处理本编辑器的所有自定义节点（math/task/markdownImage/table 等），
      // 而通用 turndown 不认识这些 data-type 节点，会丢内容。
      const markdownContent = htmlToMarkdown(editor.getHTML())
      const filename = makeFilename()

      try {
        let dirPath: string | null = null
        if (target === 'session' && activeSessionId && currentWorkspaceId) {
          // 会话目标 = 会话私有目录（storageDir）；project 下 getAgentSessionPath 是项目根，不能用来落草稿。
          dirPath = await window.electronAPI.getAgentSessionStoragePath(currentWorkspaceId, activeSessionId)
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
    if (!editor || editor.isEmpty) return

    const filename = makeFilename()
    const filePath = await window.electronAPI.chooseExportPath(filename)
    if (!filePath) return

    try {
      const markdownContent = htmlToMarkdown(editor.getHTML())
      // 传空 filename 触发 IPC 的完整路径模式，由 Node.js path.dirname 安全处理
      await window.electronAPI.exportScratchPad(markdownContent, filePath, '')
    } catch (err) {
      console.error('[ScratchPad] 导出失败:', err)
    }
  }, [editor])

  // ===== 语音输入路由 =====

  // 编辑器获得焦点时，把"语音输入目标"标记为 Scratch Pad；点击语音按钮 / 触发快捷键时编辑器会失焦，
  // 但 ID 保持不变，从而确保识别完成回填的文本会路由到这里而不是被 RichTextInput / agent draft 抢走。
  React.useEffect(() => {
    if (!editor) return
    const dom = editor.view.dom
    const handleFocus = (): void => {
      setLastFocusedVoiceInputId(SCRATCH_PAD_VOICE_INPUT_ID)
    }
    dom.addEventListener('focus', handleFocus, true)
    return () => dom.removeEventListener('focus', handleFocus, true)
  }, [editor])

  // 监听语音输入回填事件：仅在"上次聚焦目标"是 Scratch Pad 时消费，插入到当前光标位置
  React.useEffect(() => {
    if (!editor) return
    const handler = (event: Event): void => {
      if (getLastFocusedVoiceInputId() !== SCRATCH_PAD_VOICE_INPUT_ID) return
      const customEvent = event as CustomEvent<{ text?: string }>
      const text = customEvent.detail?.text?.trim()
      if (!text) return
      editor.chain().focus().insertContent({ type: 'text', text }).run()
      event.preventDefault()
    }
    window.addEventListener(VOICE_DICTATION_INSERT_EVENT, handler)
    return () => window.removeEventListener(VOICE_DICTATION_INSERT_EVENT, handler)
  }, [editor])

  // ===== 粘贴处理 =====

  // 粘贴时：图片转 data URL 插入；含 markdown 标记的文本走 markdownToHtml 转 HTML 注入
  React.useEffect(() => {
    const el = containerRef.current
    if (!el || !editor) return

    const handlePaste = (e: ClipboardEvent): void => {
      // 检测剪贴板中的图片
      const items = e.clipboardData?.items
      if (items) {
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            e.preventDefault()
            e.stopPropagation()
            const file = item.getAsFile()
            if (!file) return
            const reader = new FileReader()
            reader.onload = () => {
              editor.chain().focus().insertContent({
                type: 'markdownImage',
                attrs: { src: reader.result as string, alt: '', title: '' },
              }).run()
            }
            reader.readAsDataURL(file)
            return
          }
        }
      }

      const text = e.clipboardData?.getData('text/plain')
      if (!text) return

      // 阻止事件冒泡到 ProseMirror，我们自己插入内容
      // （Electron 39+ sandbox 环境下 ProseMirror 内部 paste 处理不可靠）
      e.preventDefault()
      e.stopPropagation()
      // markdown 触发字符：#标题 *强调 >引用 -列表 `代码 [链接 ~删除 |表格 $公式
      if (/[#*>\-`[\]~|$]/.test(text)) {
        try {
          const html = markdownToHtml(text)
          editor.chain().focus().insertContent(html).run()
          return
        } catch {
          // 转换失败，回退到纯文本插入
        }
      }
      editor.chain().focus().insertContent(text).run()
    }

    el.addEventListener('paste', handlePaste, true)
    return () => el.removeEventListener('paste', handlePaste, true)
  }, [editor])

  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const handleFileSelect = React.useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    void Promise.all(files.map(insertFile))
  }, [insertFile])

  return (
    <div
      ref={containerRef}
      className="relative flex h-full flex-col"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex-1 overflow-auto scrollbar-thin px-8 pt-6 pb-20">
        <div className="max-w-3xl mx-auto">
          <div className="mb-5 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-xl font-semibold tracking-normal text-foreground">草稿页</h1>
                <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
                  把文字、图片和临时想法先放在这里，再整理到会话或工作区。
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*,.md,.markdown,.txt,.json,.csv,.log"
                  className="hidden"
                  onChange={handleFileSelect}
                />
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => fileInputRef.current?.click()}
                  title="插入图片或文本文件"
                >
                  <ImagePlus className="h-3.5 w-3.5" />
                  插入文件
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground/80">
              <span className="rounded-md bg-muted px-2 py-1">临时笔记</span>
              <span className="rounded-md bg-muted px-2 py-1">Todo 草稿</span>
              <span className="rounded-md bg-muted px-2 py-1">剪贴板暂存</span>
            </div>
          </div>
          {loaded && editor ? (
            <div className="overflow-hidden rounded-lg border border-border/70 bg-background/40 shadow-sm">
              <MarkdownEditorToolbar editor={editor} />
              <div className="relative">
                <EditorContent
                  editor={editor}
                  className="prose prose-sm dark:prose-invert max-w-none px-5 py-4 [&_.ProseMirror]:min-h-[42vh] [&_.ProseMirror]:outline-none [&_.ProseMirror]:text-sm [&_.ProseMirror_p.is-editor-empty:first-child::before]:text-muted-foreground/50 [&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left [&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none [&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0"
                />
                {isDragging && (
                  <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-md border-2 border-dashed border-primary bg-primary/5 text-sm font-medium text-primary">
                    松开以插入图片或文件
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="min-h-[200px] flex items-center justify-center">
              <span className="text-sm text-muted-foreground/40">加载中…</span>
            </div>
          )}
        </div>
      </div>
      {/* 底部居中悬浮：圆形语音输入按钮 */}
      <div className="absolute left-1/2 -translate-x-1/2 bottom-10 z-20">
        <SpeechButton className="size-11 rounded-full bg-background/95 border border-border/60 shadow-md backdrop-blur hover:bg-accent text-foreground/80" />
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
