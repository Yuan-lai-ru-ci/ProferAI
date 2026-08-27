/**
 * AI Elements - TipTap 富文本输入组件
 *
 * 独立受控组件，不依赖 PromptInput Provider。
 *
 * 功能：
 * - StarterKit + Placeholder + Underline + Link + CodeBlockLowlight
 * - 可选 Mention 扩展（@ 引用文件、/ 触发 Skill、# 触发 MCP、& 引用会话）
 * - htmlToMarkdown 转换
 * - IME composition 处理
 * - Enter 提交 / Shift+Enter 换行
 * - tabletMode（触屏无 Shift 键）：Enter 换行，Ctrl/Cmd+Enter 或发送按钮提交
 * - 代码块内 Enter 换行例外
 * - 自动扩高
 */

import { useState, useEffect, useRef, useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Mention from '@tiptap/extension-mention'
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { lowlight } from '@/lib/lowlight'
import { htmlToMarkdown, markdownToHtml, normalizeClipboardHtml } from '@/lib/markdown-rich-text'
import { richTextRenderingEnabledAtom } from '@/atoms/ui-preferences'
import { createFileMentionSuggestion } from '@/components/file-browser/file-mention-suggestion'
import { createSkillMentionSuggestion, createMcpMentionSuggestion, createSessionMentionSuggestion } from '@/components/agent/mention-suggestions'
import { shouldConvertClipboardTextToAttachment } from '@/lib/clipboard-text-attachment'
import {
  VOICE_DICTATION_INSERT_EVENT,
  getLastFocusedVoiceInputId,
  setLastFocusedVoiceInputId,
} from '@/lib/voice-input-focus'

/** 将纯文本草稿安全地转换为 TipTap 可解析的 HTML，避免草稿中的 HTML 被执行/解释。 */
function plainTextToEditorHtml(text: string): string {
  const escapeHtml = (value: string): string => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

  return text
    .split(/\n\n+/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/** TipTap 生命周期切换期间安全地写入编辑器内容。 */
function setEditorContentSafely(editor: ReturnType<typeof useEditor>, html: string): boolean {
  if (!editor || editor.isDestroyed || !editor.commands) return false
  try {
    editor.commands.setContent(html, { emitUpdate: false })
    return true
  } catch (error) {
    // 编辑器可能正在被 TipTap 销毁；下一次 editor 变化会重新同步内容。
    if (editor.isDestroyed || !editor.view) return false
    throw error
  }
}

function clearEditorContentSafely(editor: ReturnType<typeof useEditor>): boolean {
  if (!editor || editor.isDestroyed || !editor.commands) return false
  try {
    editor.commands.clearContent(false)
    return true
  } catch (error) {
    if (editor.isDestroyed || !editor.view) return false
    throw error
  }
}

/** 读取剪贴板 HTML 的可见纯文本，去掉代码复制附带的 style/span 外壳。 */
function clipboardHtmlToPlainText(html: string): string {
  if (typeof document === 'undefined') return html
  const container = document.createElement('div')
  container.innerHTML = html
  return container.textContent || ''
}

// ===== 行数计算 =====

/** 计算编辑器内容的行数 */
function countEditorLines(editor: ReturnType<typeof useEditor>): number {
  if (!editor) return 0

  const doc = editor.state.doc
  let lineCount = 0

  doc.descendants((node) => {
    if (node.type.name === 'paragraph') {
      const text = node.textContent
      if (!text) {
        lineCount += 1
      } else {
        // 粗略估算：假设每行约50个字符
        lineCount += Math.max(1, Math.ceil(text.length / 50))
      }
    } else if (node.type.name === 'codeBlock') {
      const text = node.textContent
      lineCount += (text.match(/\n/g) || []).length + 1
    } else if (node.type.name === 'bulletList' || node.type.name === 'orderedList') {
      node.descendants((child) => {
        if (child.type.name === 'listItem') {
          lineCount += 1
        }
      })
    }
  })

  return lineCount
}

// ===== 组件接口 =====

interface RichTextInputProps {
  /** 当前值（Markdown） */
  value: string
  /** 值变更回调 */
  onChange: (markdown: string) => void
  /** 提交回调（Enter 键） */
  onSubmit: () => void
  /** 粘贴文件回调（拦截粘贴的文件） */
  onPasteFiles?: (files: File[]) => void
  /** 粘贴超长文本回调（由调用方决定是否转换为附件） */
  onPasteLongText?: (text: string) => void
  /** 触发超长文本粘贴回调的字符数阈值 */
  longTextPasteThreshold?: number
  /** 占位文字 */
  placeholder?: string
  /** 是否显示建议样式（斜体占位符） */
  suggestionActive?: boolean
  /** 是否禁用 */
  disabled?: boolean
  /** 自动聚焦触发器（当此值变化时自动聚焦，通常传入对话 ID） */
  autoFocusTrigger?: string | null
  /** 是否支持手动折叠（内容较长时显示折叠按钮） */
  collapsible?: boolean
  /** 是否启用 Mention 功能（@ 文件、/ Skill、# MCP、& 会话） */
  enableMentions?: boolean
  /** 工作区根路径（启用 @ 引用文件功能时需要） */
  workspacePath?: string | null
  /** 工作区 ID（启用 & 引用 Agent 会话功能时需要） */
  workspaceId?: string | null
  /** 工作区 slug（启用 / Skill 和 # MCP 功能时需要） */
  workspaceSlug?: string | null
  /** 当前 Agent 会话 ID（启用 & 引用 Agent 会话功能时用于排除自身） */
  sessionId?: string | null
  /** 附加目录路径列表（工作区级，@ 引用时标记为工作区文件） */
  attachedDirs?: string[]
  /** 会话级附加目录路径列表（@ 引用时标记为会话文件） */
  sessionAttachedDirs?: string[]
  /** HTML 草稿值（切换会话恢复时使用，保留 mention 等富文本结构） */
  htmlValue?: string
  /** HTML 值变更回调（用于保存富文本草稿） */
  onHtmlChange?: (html: string) => void
  /** 是否使用 Cmd/Ctrl+Enter 发送（而非 Enter） */
  sendWithCmdEnter?: boolean
  /** 移动模式：输入框压扁为单行高度（约 40px），减少触屏下输入区占用 */
  tabletMode?: boolean
  className?: string
}

/**
 * 富文本输入组件
 * - 基于 TipTap 的 WYSIWYG 编辑器
 * - 支持 Markdown 快捷输入
 * - 无工具栏，纯净输入体验
 */
export function RichTextInput({
  value,
  onChange,
  onSubmit,
  onPasteFiles,
  onPasteLongText,
  longTextPasteThreshold,
  placeholder = '有什么可以帮助到你的呢？',
  suggestionActive = false,
  className,
  disabled = false,
  autoFocusTrigger,
  collapsible = false,
  enableMentions,
  workspacePath,
  workspaceId,
  workspaceSlug,
  sessionId,
  attachedDirs = [],
  sessionAttachedDirs = [],
  htmlValue,
  onHtmlChange,
  sendWithCmdEnter = false,
  tabletMode = false,
}: RichTextInputProps): React.ReactElement {
  const [isExpanded, setIsExpanded] = useState(false)
  const inputIdRef = useRef(`rich-text-input-${Math.random().toString(36).slice(2)}`)
  // 手动折叠状态：用户主动折叠输入框
  const [isManuallyCollapsed, setIsManuallyCollapsed] = useState(false)
  // 跟踪 isExpanded 最新值（对比后再 setState，避免每键无谓 setState 触发重渲染）
  const isExpandedRef = useRef(false)
  // 行数检查的 rAF 调度句柄（用 rAF 节流，一帧最多检查一次）
  const lineCheckHandleRef = useRef<number | null>(null)
  // 跟踪编辑器自己设置的值，用于区分外部设置和内部更新
  const lastEditorValueRef = useRef<string>('')
  // 跟踪 IME 输入状态（中文输入法等）
  const isComposingRef = useRef(false)
  // 保持 onSubmit 引用最新
  const onSubmitRef = useRef(onSubmit)
  onSubmitRef.current = onSubmit
  // 保持 onPasteFiles 引用最新
  const onPasteFilesRef = useRef(onPasteFiles)
  onPasteFilesRef.current = onPasteFiles
  // 保持超长文本粘贴配置最新
  const onPasteLongTextRef = useRef(onPasteLongText)
  onPasteLongTextRef.current = onPasteLongText
  const longTextPasteThresholdRef = useRef(longTextPasteThreshold)
  longTextPasteThresholdRef.current = longTextPasteThreshold
  // 保持 onHtmlChange 引用最新
  const onHtmlChangeRef = useRef(onHtmlChange)
  onHtmlChangeRef.current = onHtmlChange
  // 发送模式引用
  const sendWithCmdEnterRef = useRef(sendWithCmdEnter)
  sendWithCmdEnterRef.current = sendWithCmdEnter
  // Mention 活跃状态（阻止 Enter 发送消息）
  const mentionActiveRef = useRef(false)
  // Mention 弹窗中的可选项数量（0 时 Enter 不阻塞发送）
  const mentionItemCountRef = useRef(0)
  // 工作区路径引用（给 Suggestion 使用）
  const workspacePathRef = useRef<string | null>(workspacePath ?? null)
  workspacePathRef.current = workspacePath ?? null
  // 工作区 ID 引用（给会话引用 Suggestion 使用）
  const workspaceIdRef = useRef<string | null>(workspaceId ?? null)
  workspaceIdRef.current = workspaceId ?? null
  // 当前会话 ID 引用（给会话引用 Suggestion 使用）
  const currentSessionIdRef = useRef<string | null>(sessionId ?? null)
  currentSessionIdRef.current = sessionId ?? null
  // 工作区级附加目录路径引用（给 Suggestion 使用，标记为 workspace）
  const attachedDirsRef = useRef<string[]>(attachedDirs)
  attachedDirsRef.current = attachedDirs
  // 会话级附加目录路径引用（给 Suggestion 使用，标记为 session）
  const sessionAttachedDirsRef = useRef<string[]>(sessionAttachedDirs)
  sessionAttachedDirsRef.current = sessionAttachedDirs
  // 工作区 slug 引用（给 Skill/MCP Suggestion 使用）
  const workspaceSlugRef = useRef<string | null>(workspaceSlug ?? null)
  workspaceSlugRef.current = workspaceSlug ?? null

  // 是否启用 Mention 功能：Agent 首帧可能尚未拿到路径/slug/id，但扩展必须先注册。
  const hasMentionSupport = enableMentions ?? (workspacePath !== undefined || workspaceSlug !== undefined || workspaceId !== undefined)

  // 输入框 Markdown 渲染开关：关闭后为纯文本模式（禁用格式化扩展 + 粘贴跳过 HTML 解析），Mention 仍保留
  const richTextEnabled = useAtomValue(richTextRenderingEnabledAtom)
  const richTextEnabledRef = useRef(richTextEnabled)
  richTextEnabledRef.current = richTextEnabled

  // Mention Suggestion 配置（稳定引用，不随 workspacePath 变化重建）
  const mentionSuggestion = useMemo(
    () => createFileMentionSuggestion(workspacePathRef, mentionActiveRef, attachedDirsRef, mentionItemCountRef, sessionAttachedDirsRef),
    [],
  )

  // Skill Suggestion 配置（/ 触发）
  const skillSuggestion = useMemo(
    () => createSkillMentionSuggestion(workspaceSlugRef, mentionActiveRef, mentionItemCountRef),
    [],
  )

  // MCP Suggestion 配置（# 触发）
  const mcpSuggestion = useMemo(
    () => createMcpMentionSuggestion(workspaceSlugRef, mentionActiveRef, mentionItemCountRef),
    [],
  )

  // Agent 会话引用 Suggestion（& 触发）
  const sessionSuggestion = useMemo(
    () => createSessionMentionSuggestion(workspaceIdRef, currentSessionIdRef, mentionActiveRef, mentionItemCountRef),
    [],
  )

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false, // 使用 CodeBlockLowlight 替代
        // TipTap v3 StarterKit 默认包含 Link 和 Underline
        // 禁用内置版本，使用下面单独配置的版本
        link: false,
        underline: false,
        // 始终保持同一份编辑器 schema。不能根据 Markdown 开关增删扩展，
        // 否则 TipTap 会销毁并重建 Editor；切换期间同步 effect 可能拿到已销毁实例。
        // 纯文本模式通过 Markdown/HTML 转换控制显示和序列化，不依赖重建 schema。
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: false,
        linkOnPaste: false,
        HTMLAttributes: {
          class: 'text-primary underline',
        },
      }),
      CodeBlockLowlight.configure({
        lowlight,
        HTMLAttributes: {
          class: 'rounded-md p-3 font-mono text-sm',
        },
      }),
      Placeholder.configure({
        placeholder,
        emptyEditorClass: 'is-editor-empty',
      }),
      // Mention 扩展：启用时注册，路径/slug 后续通过 ref 异步更新
      // @ 引用文件、/ 触发 Skill、# 触发 MCP
      // 纯文本模式下仍然保留，确保引用功能可用
      ...(hasMentionSupport ? [
        Mention.extend({
          addAttributes() {
            return {
              ...this.parent?.(),
              mentionSuggestionChar: {
                default: '@',
                parseHTML: (el: HTMLElement) => el.getAttribute('data-mention-suggestion-char') || '@',
                renderHTML: (attrs: Record<string, string>) => ({
                  'data-mention-suggestion-char': attrs.mentionSuggestionChar,
                }),
              },
            }
          },
        }).configure({
          HTMLAttributes: {},
          renderHTML({ node, suggestion }) {
            const char = suggestion?.char ?? node.attrs.mentionSuggestionChar ?? '@'
            const label = node.attrs.label ?? node.attrs.id
            let chipClass = 'mention-chip'
            if (char === '/') chipClass = 'skill-mention-chip'
            else if (char === '#') chipClass = 'mcp-mention-chip'
            else if (char === '&') chipClass = 'session-mention-chip'
            return [
              'span',
              {
                'data-type': 'mention',
                'data-id': node.attrs.id,
                'data-label': node.attrs.label,
                'data-mention-suggestion-char': char,
                class: chipClass,
              },
              `${char === '@' ? '@' : ''}${label}`,
            ]
          },
          suggestions: [
            mentionSuggestion,
            skillSuggestion,
            mcpSuggestion,
            sessionSuggestion,
          ],
        }),
      ] : []),
    ],
    // TipTap 的 content 接收 HTML；受控值是 Markdown，富文本模式下必须先解析，
    // 否则已有草稿会把 **粗体**、标题和列表当成普通文本显示。
    content: richTextEnabled ? markdownToHtml(value) : plainTextToEditorHtml(value),
    editable: !disabled,
    editorProps: {
      attributes: {
        // tabindex=0 让空间导航把编辑器视为可达目标（[tabindex]:not([tabindex="-1"])），
        // 从而左栏/右栏的箭头可以进入输入区；裸的 contenteditable 因无 tabindex 无法被聚焦。
        tabindex: '0',
        class: cn(
          'prose dark:prose-invert max-w-none focus:outline-none',
          tabletMode
            ? 'min-h-[var(--tablet-input-h,40px)] w-full text-[15px] leading-[1.4]'
            : 'min-h-[101px] w-full text-[15px] leading-[1.6]',
          '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
          '[&_pre]:rounded-md [&_pre]:p-3',
          '[&_code]:bg-muted [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-sm [&_code]:text-foreground',
          '[&_pre_code]:bg-transparent [&_pre_code]:p-0'
        ),
      },
      // 监听 IME 输入状态
      handleDOMEvents: {
        focus: () => {
          setLastFocusedVoiceInputId(inputIdRef.current)
          return false
        },
        compositionstart: () => {
          isComposingRef.current = true
          return false
        },
        compositionend: () => {
          isComposingRef.current = false
          return false
        },
        copy: (_view, event) => {
          // 复制时只写纯文本，避免粘贴到外部应用时出现多余空行
          const selection = window.getSelection()
          if (!selection || selection.isCollapsed || !event.clipboardData) return false
          const range = selection.getRangeAt(0)
          const fragment = range.cloneContents()
          const tempDiv = document.createElement('div')
          tempDiv.appendChild(fragment)
          const text = htmlToMarkdown(tempDiv.innerHTML, { skipMarkdownEscape: !richTextEnabledRef.current }) || selection.toString()
          event.preventDefault()
          event.clipboardData.setData('text/plain', text)
          event.clipboardData.setData('text/html', '')
          return true
        },
      },
      handlePaste: (view, event) => {
        // 拦截粘贴的文件（图片等）
        const clipboardItems = event.clipboardData?.files
        if (clipboardItems && clipboardItems.length > 0 && onPasteFilesRef.current) {
          event.preventDefault()
          onPasteFilesRef.current(Array.from(clipboardItems))
          return true
        }

        const threshold = longTextPasteThresholdRef.current
        const plainText = event.clipboardData?.getData('text/plain') ?? ''

        // 纯文本模式：直接插入原始文本，不经过 HTML 解析
        if (!richTextEnabledRef.current) {
          // 超长文本转附件逻辑仍然生效（按纯文本长度判断）
          if (
            threshold &&
            threshold > 0 &&
            plainText.length >= threshold &&
            onPasteLongTextRef.current
          ) {
            event.preventDefault()
            onPasteLongTextRef.current(plainText)
            return true
          }
          event.preventDefault()
          view.dispatch(view.state.tr.insertText(plainText))
          return true
        }

        const html = event.clipboardData?.getData('text/html') ?? ''
        // 预处理 HTML：将 <div> 替换为 <p>，避免 TipTap 解析时不分段。
        // 同时保留原始 HTML 供编辑器插入；不能先 htmlToMarkdown 再 markdownToHtml，
        // 因为 Markdown 序列化会把 Windows 路径的反斜杠写成 `\\`，再把这份源码
        // 当作普通粘贴内容处理就会让用户看到多余的反斜杠。
        const normalizedHtml = normalizeClipboardHtml(html)
        // 长文本附件仍需要 Markdown 版本，以便保留格式；编辑器插入则走上面的原始 HTML。
        const text = normalizedHtml
          ? (htmlToMarkdown(normalizedHtml).trim() || plainText)
          : plainText
        if (
          shouldConvertClipboardTextToAttachment({
            enabled: Boolean(threshold && onPasteLongTextRef.current),
            plainText,
            normalizedText: text,
            threshold: threshold ?? 0,
          }) &&
          onPasteLongTextRef.current
        ) {
          event.preventDefault()
          onPasteLongTextRef.current(text)
          return true
        }
        // 直接插入剪贴板 HTML，不经过 Markdown 往返，避免普通文本中的反斜杠被重复转义。
        // Electron 39+ sandbox 环境下 ProseMirror capturePaste 回退路径不可靠，因此仍由
        // 我们显式阻止默认行为并调用 TipTap；没有 HTML 时才插入原始 text/plain。
        event.preventDefault()
        if (normalizedHtml) {
          // 复制已渲染的列表/标题时保留真实 HTML；纯文本包装则解析其 Markdown。
          const hasRichHtml = /<(?:h[1-6]|ul|ol|li|blockquote|pre|table|strong|b|em|i|s|del|code|a|img|hr)\b/i.test(normalizedHtml)
          // 代码块复制出来通常是带样式的 <span>。这类 HTML 不是富文本结构，
          // 不能直接交给 TipTap，否则部分 Electron 版本会把 span/html 源码显示出来。
          // 只有明确包含标题、列表、强调、链接等结构时才保留 HTML；其余内容统一
          // 取可见文本，再按 Markdown 解析。
          const visibleText = hasRichHtml ? text : clipboardHtmlToPlainText(normalizedHtml)
          const editorContent = hasRichHtml ? normalizedHtml : markdownToHtml(visibleText)
          editor?.chain().focus().insertContent(editorContent).run()
        } else if (plainText) {
          // text/plain-only 粘贴在富文本模式下也要解析 Markdown。
          editor?.chain().focus().insertContent(markdownToHtml(plainText)).run()
        }
        return true
      },
      handleKeyDown: (view, event) => {
        // macOS 上 Cmd+B/S 被全局快捷键占用，用 Ctrl+B/S 作为格式化替代键
        // 纯文本模式下跳过，避免无效操作且不吃事件
        if (richTextEnabledRef.current) {
          const isMacOS = navigator.platform.startsWith('Mac')
          if (isMacOS && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
            const key = event.key.toLowerCase()
            if (key === 'b') {
              event.preventDefault()
              editor?.chain().focus().toggleBold().run()
              return true
            }
            if (key === 's') {
              event.preventDefault()
              editor?.chain().focus().toggleStrike().run()
              return true
            }
          }
        }

        // 发送/换行逻辑：根据 sendWithCmdEnter 模式决定行为
        if (event.key === 'Enter') {
          const cmdEnterMode = sendWithCmdEnterRef.current
          const hasCmd = event.metaKey || event.ctrlKey
          const hasShift = event.shiftKey

          // 如果在代码块中，允许正常换行
          const { state } = view
          const { $from } = state.selection
          const parent = $from.parent
          if (parent.type.name === 'codeBlock') {
            return false // 让 TipTap 处理
          }

          // 检查是否正在输入中文（IME 组合输入）
          if (isComposingRef.current || event.isComposing) {
            return false
          }

          // Suggestion（@ 文件 / / Skill / # MCP / & 会话）弹窗激活时，让 TipTap Suggestion
          // 插件处理 Enter（选中高亮项 / 关闭）。这里用实时 decoration 判定，而非 onStart 里
          // 异步设置的 mentionActiveRef/mentionItemCountRef——后者要等 items() 异步加载
          // （IPC 拉取工作区能力）resolve 后才置位，存在竞态窗口：插件已 active、补全列表
          // 正在加载时按 Enter，旧逻辑会误判为无 mention 激活而把消息直接发送出去。
          // data-decoration-id 由 @tiptap/suggestion 在 active 时同步渲染，与插件状态严格一致。
          if (view.dom.querySelector('[data-decoration-id]')) {
            return false
          }

          // 判断是发送还是换行
          // tabletMode：触屏软键盘没有 Shift 修饰键，普通 Enter 一律换行（拆分段/硬换行），
          // 发送由发送按钮或 Ctrl/Cmd+Enter 承担；桌面模式保持 Enter 发送 / Shift+Enter 换行。
          const isSend = tabletMode ? hasCmd : (cmdEnterMode ? hasCmd : (!hasShift && !hasCmd))

          if (isSend) {
            event.preventDefault()
            onSubmitRef.current()
            return true
          }

          // 换行：普通段落中 Shift+Enter 插入硬换行；列表项内使用拆分列表项生成下一条。
          event.preventDefault()
          // 检查是否在列表项内（遍历祖先节点）
          let isInList = false
          let listItemNode = null
          for (let d = $from.depth; d > 0; d--) {
            if ($from.node(d).type.name === 'listItem') {
              isInList = true
              listItemNode = $from.node(d)
              break
            }
          }
          if (isInList && editor) {
            // 空列表项再次按 Enter：退出列表，回到普通输入
            if (listItemNode && listItemNode.textContent === '') {
              editor.chain().focus().liftListItem('listItem').run()
            } else {
              // 发送模式下 Enter 会提交消息，因此 Shift+Enter 也应作为列表续项键。
              editor.chain().focus().splitListItem('listItem').run()
            }
          } else if (editor) {
            if (hasShift) {
              // Shift+Enter：同段落内硬换行
              editor.chain().focus().setHardBreak().run()
            } else {
              // 普通 Enter：拆分为新段落
              editor.chain().focus().splitBlock().run()
            }
          }
          return true
        }

        // Backspace：空列表项时退出列表
        if (event.key === 'Backspace') {
          const { state } = view
          const { $from } = state.selection
          let isInList = false
          let listItemNode = null
          for (let d = $from.depth; d > 0; d--) {
            if ($from.node(d).type.name === 'listItem') {
              isInList = true
              listItemNode = $from.node(d)
              break
            }
          }
          if (isInList && listItemNode && listItemNode.textContent === '' && editor) {
            event.preventDefault()
            editor.chain().focus().liftListItem('listItem').run()
            return true
          }
        }

        return false
      },
    },
    onUpdate: ({ editor: ed }) => {
      const html = ed.getHTML()
      if (html === '<p></p>') {
        lastEditorValueRef.current = ''
        onChange('')
        onHtmlChangeRef.current?.('')
        if (isExpandedRef.current) {
          isExpandedRef.current = false
          setIsExpanded(false)
        }
        setIsManuallyCollapsed(false)
      } else {
        const markdown = htmlToMarkdown(html, { skipMarkdownEscape: !richTextEnabledRef.current })
        lastEditorValueRef.current = markdown
        onChange(markdown)
        onHtmlChangeRef.current?.(html)

        // 行数检查用 rAF 节流：每键 doc.descendants 全文遍历 + setState 重渲染会让
        // 输入热路径变重；延后到下一帧合并连续按键，对 UX 无影响。
        if (lineCheckHandleRef.current !== null) {
          cancelAnimationFrame(lineCheckHandleRef.current)
        }
        lineCheckHandleRef.current = requestAnimationFrame(() => {
          lineCheckHandleRef.current = null
          const nextExpanded = countEditorLines(ed) > 5
          if (nextExpanded !== isExpandedRef.current) {
            isExpandedRef.current = nextExpanded
            setIsExpanded(nextExpanded)
          }
        })
      }
    },
  }, [])

  // 卸载时取消未触发的 rAF 行数检查，避免泄漏 / 在卸载组件上 setState
  useEffect(() => {
    return () => {
      if (lineCheckHandleRef.current !== null) {
        cancelAnimationFrame(lineCheckHandleRef.current)
        lineCheckHandleRef.current = null
      }
    }
  }, [])

  // 追踪编辑器实例，重建时强制同步（避免 htmlValue 草稿丢失）
  const editorInstanceRef = useRef(editor)
  // Markdown 开关切换时，即使 value 没变化，也必须重新构造编辑器内容。
  const lastRichTextModeRef = useRef(richTextEnabled)
  // 同步外部 value 变化（清空时）
  useEffect(() => {
    // useEditor 在初始化/生命周期切换时可能暂时返回 null；所有命令调用都必须
    // 通过可选链保护，不能假设编辑器实例在 effect 执行期间始终存在。
    const currentEditor = editor
    if (!currentEditor || currentEditor.isDestroyed) return

    {
      const controllerValue = value
      const isEditorRecreated = currentEditor !== editorInstanceRef.current
      const isRichTextModeChanged = lastRichTextModeRef.current !== richTextEnabled
      editorInstanceRef.current = currentEditor
      lastRichTextModeRef.current = richTextEnabled
      // 如果值是编辑器自己设置的，跳过同步；但编辑器重建或 Markdown 开关切换后，
      // 即使 value 未变也必须重新解析，避免富文本/纯文本模式显示错误。
      if (!isEditorRecreated && !isRichTextModeChanged && controllerValue === lastEditorValueRef.current) {
        return
      }

      if (controllerValue === '') {
        clearEditorContentSafely(currentEditor)
        lastEditorValueRef.current = ''
        isExpandedRef.current = false
        setIsExpanded(false)
        setIsManuallyCollapsed(false)
      } else if (htmlValue && richTextEnabled && !isRichTextModeChanged) {
        // 优先使用 HTML 草稿恢复（保留 mention 等富文本节点）。开关刚切换时不能
        // 使用旧 HTML，否则纯文本模式下的 **粗体** 会继续保留为富文本，反之亦然。
        setEditorContentSafely(currentEditor, htmlValue)
        lastEditorValueRef.current = controllerValue
      } else {
        // 受控值是 Markdown，富文本模式下要经过同一套 Markdown → HTML 管线；
        // 纯文本模式则转义后再放进段落，避免原始 HTML 被 TipTap 当成 DOM 解析。
        const html = richTextEnabled
          ? markdownToHtml(controllerValue)
          : plainTextToEditorHtml(controllerValue)
        setEditorContentSafely(currentEditor, html)
        lastEditorValueRef.current = controllerValue
      }
    }
  }, [editor, value, richTextEnabled])

  // 同步 disabled 状态
  useEffect(() => {
    if (editor) {
      editor.setEditable(!disabled)
    }
  }, [editor, disabled])

  // 动态更新 placeholder 文本
  useEffect(() => {
    if (!editor) return
    const placeholderExt = editor.extensionManager.extensions.find(
      (ext) => ext.name === 'placeholder'
    )
    if (placeholderExt) {
      placeholderExt.options.placeholder = placeholder
      // 触发 TipTap 重新渲染 placeholder
      editor.view.dispatch(editor.state.tr)
    }
  }, [editor, placeholder])

  // 自动聚焦：组件挂载时 + autoFocusTrigger 变化时。
  // 平板触屏禁用：切换 Agent/Chat 模式、打开会话都会重挂载输入框，自动聚焦会弹出软键盘；
  // 触屏用户点击输入框时主动聚焦即可。
  useEffect(() => {
    if (editor && !disabled && !tabletMode) {
      const timer = setTimeout(() => {
        editor?.commands?.focus()
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [editor, disabled, autoFocusTrigger, tabletMode])

  // 语音输入回填：优先插入到当前编辑器的光标位置。
  useEffect(() => {
    if (!editor || disabled) return

    const handler = (event: Event): void => {
      if (getLastFocusedVoiceInputId() !== inputIdRef.current) return

      const customEvent = event as CustomEvent<{ text?: string }>
      const text = customEvent.detail?.text?.trim()
      if (!text) return

      editor.chain().focus().insertContent(text).run()
      event.preventDefault()
    }

    window.addEventListener(VOICE_DICTATION_INSERT_EVENT, handler)
    return () => window.removeEventListener(VOICE_DICTATION_INSERT_EVENT, handler)
  }, [editor, disabled])

  // 是否显示折叠按钮：启用 collapsible 且内容已自动扩展
  const showCollapseToggle = collapsible && isExpanded

  return (
    <div
      className={cn(
        'rich-text-input relative w-full overflow-y-auto scrollbar-thin transition-[max-height] duration-200 ease-in-out',
        isManuallyCollapsed
          ? tabletMode ? 'max-h-[var(--tablet-input-h,40px)]' : 'max-h-[101px]'
          : isExpanded ? 'max-h-[500px]' : 'max-h-[200px]',
        disabled && 'opacity-50 cursor-not-allowed',
        className
      )}
    >
      <EditorContent editor={editor} className="w-full" />
      {/* 折叠/展开切换按钮 — sticky 悬浮在滚动区域内 */}
      {showCollapseToggle && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="sticky bottom-1 float-right mr-2 z-10 p-0.5 rounded hover:bg-muted/80 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              onClick={() => setIsManuallyCollapsed((prev) => !prev)}
            >
              {isManuallyCollapsed ? (
                <ChevronsUpDown className="size-3.5" />
              ) : (
                <ChevronsDownUp className="size-3.5" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {isManuallyCollapsed ? '展开输入框' : '折叠输入框'}
          </TooltipContent>
        </Tooltip>
      )}
      <style>{`
        .ProseMirror {
          outline: none;
          padding: ${tabletMode ? '5px 15px 0px' : '9px 15px 0px'};
          font-style: normal;
        }
        .ProseMirror p {
          font-style: normal;
          margin: 0;
        }
        .ProseMirror ul,
        .ProseMirror ol {
          margin: 0;
          padding-left: 1.5em;
        }
        .ProseMirror li {
          margin: 0;
        }
        .ProseMirror p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          color: hsl(var(--muted-foreground));
          pointer-events: none;
          height: 0;
          opacity: 0.5;
          font-style: ${suggestionActive ? 'italic' : 'normal'};
        }
        .ProseMirror::-webkit-scrollbar {
          width: 3px;
        }
        .mention-chip {
          background-color: hsl(var(--primary) / 0.1);
          color: hsl(var(--primary));
          border-radius: 4px;
          padding: 1px 4px 1px 2px;
          font-size: 13px;
          font-weight: 500;
          white-space: nowrap;
          display: inline-flex;
          align-items: center;
          gap: 2px;
          vertical-align: baseline;
        }
        .mention-chip::before {
          content: '';
          display: inline-block;
          width: 12px;
          height: 12px;
          background-color: currentColor;
          mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'/%3E%3Cpath d='M14 2v4a2 2 0 0 0 2 2h4'/%3E%3C/svg%3E");
          mask-size: contain;
          mask-repeat: no-repeat;
          flex-shrink: 0;
        }
        .skill-mention-chip {
          background-color: hsl(270 60% 60% / 0.15);
          color: hsl(270 60% 50%);
          border-radius: 4px;
          padding: 1px 4px 1px 2px;
          font-size: 13px;
          font-weight: 500;
          white-space: nowrap;
          display: inline-flex;
          align-items: center;
          gap: 2px;
          vertical-align: baseline;
        }
        .skill-mention-chip::before {
          content: '';
          display: inline-block;
          width: 12px;
          height: 12px;
          background-color: currentColor;
          mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z'/%3E%3C/svg%3E");
          mask-size: contain;
          mask-repeat: no-repeat;
          flex-shrink: 0;
        }
        .mcp-mention-chip {
          background-color: hsl(160 60% 45% / 0.15);
          color: hsl(160 60% 35%);
          border-radius: 4px;
          padding: 1px 4px 1px 2px;
          font-size: 13px;
          font-weight: 500;
          white-space: nowrap;
          display: inline-flex;
          align-items: center;
          gap: 2px;
          vertical-align: baseline;
        }
        .mcp-mention-chip::before {
          content: '';
          display: inline-block;
          width: 12px;
          height: 12px;
          background-color: currentColor;
          mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='20' height='8' x='2' y='2' rx='2' ry='2'/%3E%3Crect width='20' height='8' x='2' y='14' rx='2' ry='2'/%3E%3Cline x1='6' x2='6.01' y1='6' y2='6'/%3E%3Cline x1='6' x2='6.01' y1='18' y2='18'/%3E%3C/svg%3E");
          mask-size: contain;
          mask-repeat: no-repeat;
          flex-shrink: 0;
        }
        .session-mention-chip {
          background-color: hsl(200 80% 50% / 0.14);
          color: hsl(200 80% 40%);
          border-radius: 4px;
          padding: 1px 4px 1px 2px;
          font-size: 13px;
          font-weight: 500;
          white-space: nowrap;
          display: inline-flex;
          align-items: center;
          gap: 2px;
          vertical-align: baseline;
        }
        .session-mention-chip::before {
          content: '';
          display: inline-block;
          width: 12px;
          height: 12px;
          background-color: currentColor;
          mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'/%3E%3Cpath d='M8 9h8'/%3E%3Cpath d='M8 13h6'/%3E%3C/svg%3E");
          mask-size: contain;
          mask-repeat: no-repeat;
          flex-shrink: 0;
        }
      `}</style>
    </div>
  )
}
