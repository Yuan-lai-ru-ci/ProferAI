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
 * - 代码块内 Enter 换行例外
 * - 自动扩高
 */

import { useState, useEffect, useRef, useMemo, useImperativeHandle, forwardRef, useCallback } from 'react'
import { useAtomValue } from 'jotai'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Mention from '@tiptap/extension-mention'
import { QuoteRef, QUOTE_REF_NODE_NAME, type QuoteRefPayload } from './quote-ref-node'
import type { QuotedSelection } from '@/atoms/preview-atoms'
import { getQuotedSelectionKey } from '@/lib/quoted-selection'
import { renderSessionMention, handleSessionMentionMouseDown, handleSessionMentionClick, handleSessionMentionKeyDown } from './session-mention'
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@profer/ui/primitives/tooltip'
import { cn } from '@/lib/utils'
import { lowlight } from '@/lib/lowlight'
import { htmlToMarkdown, markdownToHtml, normalizeClipboardHtml } from '@/lib/markdown-rich-text'
import { composerCompactModeAtom, richTextRenderingEnabledAtom } from '@/atoms/ui-preferences'
import {
  resolveCompactViewport,
  resolveComposerMaxHeight,
  resolveComposerMinHeight,
} from '@/lib/composer-compact-height'
import { useWindowInnerHeight } from '@/hooks/use-window-inner-height'
import { createFileMentionSuggestion } from '@/components/file-browser/file-mention-suggestion'
import { createSkillMentionSuggestion, createMcpMentionSuggestion, createSessionMentionSuggestion } from '@/components/agent/mention-suggestions'
import { shouldConvertClipboardTextToAttachment } from '@/lib/clipboard-text-attachment'
type FilePanelDragItem = { path: string; name: string; isDirectory?: boolean }
import { getSessionReferenceDragData, type SessionReferenceDragItem } from '@/lib/session-reference-drag'
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

// ===== 视口紧凑档 =====

/**
 * 视口高度驱动的「紧凑档」：窗口内高低于设置阈值时把输入框整体压矮。
 *
 * 两个防抖动措施（2026-09-13 曾经因为反复跳档而移除过这个能力）：
 * 1) 迟滞：进入/退出用不同阈值（见 resolveCompactViewport），窗口停在阈值附近不会反复切换；
 * 2) 高度变化由 useWindowInnerHeight 统一 rAF 节流，一帧最多判定一次。
 * 状态未变化时返回原值，React 会跳过重渲染。
 */
function useCompactViewport(threshold: number, viewportHeight: number): boolean {
  const [isCompact, setIsCompact] = useState(() =>
    resolveCompactViewport(false, viewportHeight, threshold)
  )

  useEffect(() => {
    setIsCompact((previous: boolean) => resolveCompactViewport(previous, viewportHeight, threshold))
  }, [viewportHeight, threshold])

  return isCompact
}

// ===== 组件接口 =====

interface RichTextInputProps {
  /** 当前值（Markdown） */
  value: string
  /** 值变更回调 */
  onChange: (markdown: string) => void
  /** 草稿在空与非空之间切换时通知外层，不随每个字符重复触发。 */
  onDraftPresenceChange?: (hasDraft: boolean) => void
  /** 提交回调（Enter 键）；传入编辑器最新 Markdown，避免防抖草稿尚未上浮时丢字。 */
  onSubmit: (markdown?: string) => void
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
  className?: string
}

/** RichTextInput 对外暴露的命令接口。 */
export interface RichTextInputHandle {
  getMarkdown: () => string
  insertFileMentions: (items: FilePanelDragItem[]) => void
  insertSessionMention: (item: SessionReferenceDragItem) => boolean
  /** 在光标处插入纯文本（手写识别结果回填用） */
  insertText: (text: string) => boolean
  /** 在光标处插入一条内联引用（`[n] 文件名` 胶囊） */
  insertQuoteReference: (quote: QuotedSelection) => boolean
  /** 按文档顺序取出正文里的全部引用（编号由节点维护，1..k） */
  getQuoteSelections: () => QuotedSelection[]
}

/**
 * 富文本输入组件
 * - 基于 TipTap 的 WYSIWYG 编辑器
 * - 支持 Markdown 快捷输入
 * - 无工具栏，纯净输入体验
 */
export const RichTextInput = forwardRef<RichTextInputHandle, RichTextInputProps>(function RichTextInput({
  value,
  onChange,
  onDraftPresenceChange,
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
}: RichTextInputProps, ref: React.Ref<RichTextInputHandle>): React.ReactElement {
  const [isExpanded, setIsExpanded] = useState(false)
  const inputIdRef = useRef(`rich-text-input-${Math.random().toString(36).slice(2)}`)
  // 手动折叠状态：用户主动折叠输入框
  const [isManuallyCollapsed, setIsManuallyCollapsed] = useState(false)
  // 跟踪 isExpanded 最新值（对比后再 setState，避免每键无谓 setState 触发重渲染）
  const isExpandedRef = useRef(false)
  // 行数检查的 rAF 调度句柄（用 rAF 节流，一帧最多检查一次）
  const lineCheckHandleRef = useRef<number | null>(null)
  // 输入热路径只保留最新 HTML；Markdown 序列化和全局草稿更新在短暂空闲后合并。
  const draftSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestHtmlRef = useRef('')
  const lastSyncedValueRef = useRef(value)
  const hasPendingLocalDraftRef = useRef(false)
  const draftPresenceRef = useRef(value.trim().length > 0)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onDraftPresenceChangeRef = useRef(onDraftPresenceChange)
  onDraftPresenceChangeRef.current = onDraftPresenceChange
  const flushDraftRef = useRef<() => string>(() => '')
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

  // 矮窗口压缩：阈值/高度来自设置（0 = 关闭），默认 < 700px 时输入框 81px → 60px、上限 200px → 140px
  const composerCompactMode = useAtomValue(composerCompactModeAtom)
  const viewportHeight = useWindowInnerHeight()
  const isCompactViewport = useCompactViewport(composerCompactMode.viewportHeight, viewportHeight)

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
      // 内联引用节点：与 Mention 同理始终注册，纯文本模式也保留
      QuoteRef,
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
            if (char === '&') return renderSessionMention(node.attrs.id, label)
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
                'data-session-reference': char === '&' ? 'true' : undefined,
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
      // 自定义拖拽载荷由 Agent 外层处理，避免 text/plain 兜底内容被 ProseMirror 当成普通文本插入。
      handleDrop: (_view, event) => {
        if (event.dataTransfer && getSessionReferenceDragData(event.dataTransfer)) {
          event.preventDefault()
          return true
        }
        return false
      },
      attributes: {
        // tabindex=0 让空间导航把编辑器视为可达目标（[tabindex]:not([tabindex="-1"])），
        // 从而左栏/右栏的箭头可以进入输入区；裸的 contenteditable 因无 tabindex 无法被聚焦。
        tabindex: '0',
        class: cn(
          'prose dark:prose-invert max-w-none focus:outline-none',
          // min-height 不用 Tailwind 固定类：紧凑档要按窗口高度变（见 .rich-text-input .ProseMirror 规则）
          'w-full text-[15px] leading-[1.6]',
          '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
          '[&_pre]:rounded-md [&_pre]:p-3',
          '[&_code]:bg-muted [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-sm [&_code]:text-foreground',
          '[&_pre_code]:bg-transparent [&_pre_code]:p-0'
        ),
      },
      // 监听 IME 输入状态
      handleDOMEvents: {
        mousedown: handleSessionMentionMouseDown,
        click: handleSessionMentionClick,
        keydown: handleSessionMentionKeyDown,
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

          // 判断是发送还是换行：桌面保持 Enter 发送 / Shift+Enter 换行（cmdEnterMode 下改为 Cmd/Ctrl+Enter 发送）。
          const isSend = cmdEnterMode ? hasCmd : (!hasShift && !hasCmd)

          if (isSend) {
            event.preventDefault()
            flushDraftRef.current()
            onSubmitRef.current(lastSyncedValueRef.current)
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
      latestHtmlRef.current = html
      const isEmpty = html === '<p></p>'
      if (draftPresenceRef.current !== !isEmpty) {
        draftPresenceRef.current = !isEmpty
        onDraftPresenceChangeRef.current?.(!isEmpty)
      }

      if (isEmpty) {
        if (draftSyncTimerRef.current !== null) {
          clearTimeout(draftSyncTimerRef.current)
          draftSyncTimerRef.current = null
        }
        hasPendingLocalDraftRef.current = false
        lastEditorValueRef.current = ''
        lastSyncedValueRef.current = ''
        onChangeRef.current('')
        onHtmlChangeRef.current?.('')
        if (isExpandedRef.current) {
          isExpandedRef.current = false
          setIsExpanded(false)
        }
        setIsManuallyCollapsed(false)
        return
      }

      hasPendingLocalDraftRef.current = true
      // 连续输入时只保留最新一次 HTML，避免每个字符都重新解析整个 TipTap 文档。
      if (draftSyncTimerRef.current !== null) clearTimeout(draftSyncTimerRef.current)
      draftSyncTimerRef.current = setTimeout(() => flushDraftRef.current(), 180)

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
    },
  }, [])

  const flushDraft = useCallback((): string => {
    if (!hasPendingLocalDraftRef.current) return lastSyncedValueRef.current
    const html = latestHtmlRef.current
    const markdown = htmlToMarkdown(html, { skipMarkdownEscape: !richTextEnabledRef.current })
    hasPendingLocalDraftRef.current = false
    if (draftSyncTimerRef.current !== null) {
      clearTimeout(draftSyncTimerRef.current)
      draftSyncTimerRef.current = null
    }
    lastEditorValueRef.current = markdown
    lastSyncedValueRef.current = markdown
    onChangeRef.current(markdown)
    onHtmlChangeRef.current?.(html)
    return markdown
  }, [])
  flushDraftRef.current = flushDraft

  // 卸载时最后一次同步草稿，并清理未触发的 rAF 行数检查。
  useEffect(() => {
    return () => {
      flushDraftRef.current()
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
      // 外部 HTML 草稿可能晚于编辑器挂载才到（独立会话窗口先挂载、再从 bootstrap 恢复）。
      // 这种情况 value 可能没变，但必须用 HTML 重放，否则引用/mention 节点会退化成纯文本。
      const htmlChanged = htmlValue != null && htmlValue !== latestHtmlRef.current
      // 如果值是编辑器自己设置的，跳过同步；但编辑器重建、Markdown 开关切换或外部 HTML
      // 草稿到达后，即使 value 未变也必须重新解析，避免富文本/纯文本模式显示错误。
      if (!isEditorRecreated && !isRichTextModeChanged && controllerValue === lastEditorValueRef.current && !htmlChanged) {
        return
      }
      // 连续输入尚未同步到外层时，外层仍持有上一次已同步值；不能反向覆盖编辑器。
      if (!isEditorRecreated && !isRichTextModeChanged && hasPendingLocalDraftRef.current && controllerValue === lastSyncedValueRef.current) {
        return
      }

      if (controllerValue === '') {
        clearEditorContentSafely(currentEditor)
        lastEditorValueRef.current = ''
        lastSyncedValueRef.current = ''
        latestHtmlRef.current = ''
        hasPendingLocalDraftRef.current = false
        draftPresenceRef.current = false
        onDraftPresenceChangeRef.current?.(false)
        setIsExpanded(false)
        setIsManuallyCollapsed(false)
      } else if (htmlValue && !isRichTextModeChanged) {
        // 优先使用 HTML 草稿恢复：Markdown 只保留了 `[n]` 文本，按 Markdown 重建会把
        // 内联引用节点（以及 mention 的附加属性）冲掉——用户输入文字后引用就消失。
        // 纯文本模式同样适用：HTML 就是这份纯文本的转义结果，不含富文本语义。
        // 仅在「富文本开关刚切换」时才必须走 Markdown 重新解析，避免模式间残留格式。
        setEditorContentSafely(currentEditor, htmlValue)
        lastEditorValueRef.current = controllerValue
        lastSyncedValueRef.current = controllerValue
        latestHtmlRef.current = htmlValue
        hasPendingLocalDraftRef.current = false
        draftPresenceRef.current = controllerValue.trim().length > 0
      } else {
        // 受控值是 Markdown，富文本模式下要经过同一套 Markdown → HTML 管线；
        // 纯文本模式则转义后再放进段落，避免原始 HTML 被 TipTap 当成 DOM 解析。
        const html = richTextEnabled
          ? markdownToHtml(controllerValue)
          : plainTextToEditorHtml(controllerValue)
        setEditorContentSafely(currentEditor, html)
        lastEditorValueRef.current = controllerValue
        lastSyncedValueRef.current = controllerValue
        latestHtmlRef.current = html
        hasPendingLocalDraftRef.current = false
        draftPresenceRef.current = controllerValue.trim().length > 0
      }
    }
  }, [editor, value, htmlValue, richTextEnabled])
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
  useEffect(() => {
    if (editor && !disabled) {
      const timer = setTimeout(() => {
        editor?.commands?.focus()
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [editor, disabled, autoFocusTrigger])

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

  // 当前档位的 max-height：手动折叠 > 紧凑档（视口矮）> 展开/默认档
  const composerMaxHeight = resolveComposerMaxHeight({
    manuallyCollapsed: isManuallyCollapsed,
    expanded: isExpanded,
    compact: isCompactViewport,
    compactMaxHeight: composerCompactMode.maxHeight,
  })
  // 编辑器 min-height：空内容时的可见高度，紧凑档下变矮（默认 81 → 60）
  const composerMinHeight = resolveComposerMinHeight({
    compact: isCompactViewport,
    compactMinHeight: composerCompactMode.minHeight,
  })

  useImperativeHandle(ref, () => ({
    getMarkdown: () => htmlToMarkdown(editor?.getHTML() ?? ''),
    insertFileMentions: (items) => {
      if (!editor || items.length === 0) return
      let chain = editor.chain().focus()
      for (const item of items) {
        chain = chain.insertContent({ type: 'mention', attrs: { id: item.path, label: item.name, mentionSuggestionChar: '@', isDirectory: item.isDirectory ?? false } }).insertContent(' ')
      }
      chain.run()
    },
    insertSessionMention: (item) => {
      if (!editor || !editor.isEditable) return false
      editor.chain().focus().insertContent({ type: 'mention', attrs: { id: item.sessionId, label: item.title, mentionSuggestionChar: '&' } }).insertContent(' ').run()
      return true
    },
    insertText: (text) => {
      if (!editor || editor.isDestroyed || !editor.isEditable) return false
      const trimmed = text.trim()
      if (trimmed.length === 0) return false
      editor.chain().focus().insertContent(trimmed).run()
      return true
    },
    insertQuoteReference: (quote) => {
      if (!editor || editor.isDestroyed || !editor.isEditable) return false
      const { ref: _ref, ...payload } = quote
      const targetKey = getQuotedSelectionKey(quote)

      // 引用统一排在正文最前面的一行里：先收齐现有引用，按文档顺序 + 新条目重排，
      // 再整体删掉旧节点、在文档开头重新插入。这样编号顺序 = 行内顺序 = 插入顺序。
      const existing: QuoteRefPayload[] = []
      const positions: number[] = []
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== QUOTE_REF_NODE_NAME) return
        const current = node.attrs.quote as QuoteRefPayload | null
        if (!current) return
        positions.push(pos)
        existing.push(current)
      })
      if (existing.some((current) => getQuotedSelectionKey(current) === targetKey)) return false

      // 浏览器自动划词只保留最新一条，不累积
      const kept = existing.filter((current) => !(payload.origin === 'browser-selection' && current.origin === 'browser-selection'))
      const nextQuotes = [...kept, payload as QuoteRefPayload]

      if (positions.length > 0) {
        let removal = editor.chain()
        for (const pos of [...positions].sort((a, b) => b - a)) {
          removal = removal.deleteRange({ from: pos, to: pos + 1 })
        }
        removal.run()
      }

      const chipContent = nextQuotes.flatMap((current) => ([
        // n 由 renumber 插件按文档顺序重排，这里给个占位值即可
        { type: QUOTE_REF_NODE_NAME, attrs: { n: 1, quote: current } },
        { type: 'text' as const, text: ' ' },
      ]))

      // 删掉旧胶囊后，如果首段正好空出来了（它就是引用行），直接复用它——
      // 否则每加一条引用都会在最上面多留一个空段落。
      const firstBlock = editor.state.doc.firstChild
      const canReuseFirst = firstBlock?.type.name === 'paragraph' && firstBlock.content.size === 0

      if (canReuseFirst) {
        editor.chain().insertContentAt(1, chipContent).run()
        // 整篇只有这一行（用户还没写正文）：光标落到引用行末尾，接着写
        if (editor.state.doc.childCount === 1) {
          const end = 1 + (editor.state.doc.firstChild?.content.size ?? 0)
          editor.commands.setTextSelection(end)
        }
      } else {
        // 已有正文：引用单独占**最前面一行**，正文整体下移，避免胶囊混在句子里
        editor.chain().insertContentAt(0, { type: 'paragraph', content: chipContent }).run()
      }
      return true
    },
    getQuoteSelections: () => {
      if (!editor || editor.isDestroyed) return []
      const collected: QuotedSelection[] = []
      editor.state.doc.descendants((node) => {
        if (node.type.name !== QUOTE_REF_NODE_NAME) return
        const payload = node.attrs.quote as QuoteRefPayload | null
        if (!payload) return
        collected.push({ ...payload, ref: Number(node.attrs.n) || collected.length + 1 })
      })
      return collected
    },
  }), [editor])

  return (
    <div
      className={cn(
        // 保留 class 供 CSS 选择器（.rich-text-input .tiptap）和调用方 className 覆盖尺寸
        'rich-text-input relative w-full overflow-y-auto scrollbar-thin',
        disabled && 'opacity-50 cursor-not-allowed',
        className
      )}
      // 高度用内联 style：紧凑档由视口高度驱动，档位随时可变，不适合穷举成 class。
      // 不给 max-height 加过渡：档位切换发生在窗口 resize 收敛点，叠加动画会把一次离散
      // 重排拉长成连续 reflow，反过来推动滚动容器的 ResizeObserver。
      style={{
        maxHeight: `${composerMaxHeight}px`,
        // 供 <style> 里的 .rich-text-input .ProseMirror 规则读取（每个实例各自生效）
        '--composer-editor-min-height': `${composerMinHeight}px`,
      } as React.CSSProperties}
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
        /* 编辑器最小高度由 CSS 变量驱动：紧凑档下矮窗口把输入框压矮（默认 81 → 60）。 */
        .rich-text-input .ProseMirror {
          min-height: var(--composer-editor-min-height, 81px);
        }
        .ProseMirror {
          outline: none;
          padding: 9px 15px 0px;
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
        .quote-ref-chip {
          position: relative;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          height: 18px;
          margin: 0 1px;
          /* 右侧常驻 15px：给 × 留位，避免 hover 时才挤开或压到下一个胶囊 */
          padding: 0 15px 0 2px;
          border-radius: 4px;
          background-color: hsl(var(--primary) / 0.1);
          color: hsl(var(--primary));
          font-size: 11.5px;
          font-weight: 500;
          line-height: 1;
          white-space: nowrap;
          vertical-align: 1px;
          cursor: default;
          user-select: none;
        }
        .quote-ref-chip__n {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 14px;
          height: 14px;
          padding: 0 3px;
          border-radius: 3px;
          background-color: hsl(var(--primary));
          color: hsl(var(--primary-foreground, 0 0% 100%));
          font-size: 9.5px;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
        }
        .quote-ref-chip__sep {
          width: 1px;
          height: 9px;
          background-color: currentColor;
          opacity: 0.28;
        }
        .quote-ref-chip__label {
          max-width: 120px;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        /* 悬停才出现的移除按钮：落在胶囊内部预留的 15px 里，不遮挡相邻胶囊 */
        .quote-ref-chip__remove {
          position: absolute;
          right: 2px;
          top: 50%;
          transform: translateY(-50%);
          z-index: 2;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 12px;
          height: 12px;
          padding: 0;
          border: none;
          border-radius: 3px;
          background-color: transparent;
          color: currentColor;
          font-size: 11px;
          line-height: 1;
          cursor: pointer;
          opacity: 0;
          pointer-events: none;
          transition: opacity 100ms ease, background-color 120ms ease, color 120ms ease;
        }
        .quote-ref-chip:hover .quote-ref-chip__remove,
        .quote-ref-chip__remove:focus-visible {
          opacity: 0.75;
          pointer-events: auto;
        }
        .quote-ref-chip__remove:hover {
          opacity: 1;
          background-color: hsl(var(--destructive) / 0.14);
          color: hsl(var(--destructive, 0 70% 50%));
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
        /* 会话引用：Profer 风格的上下文胶囊。使用语义 token，确保深浅色和自定义主题一致。 */
        .session-mention-chip {
          position: relative;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          max-width: min(19rem, 70%);
          margin: 0 2px;
          padding: 3px 9px 3px 7px;
          overflow: hidden;
          vertical-align: -0.16em;
          white-space: nowrap;
          border: 1px solid hsl(var(--primary) / 0.18);
          border-radius: 7px;
          background: linear-gradient(180deg, hsl(var(--primary) / 0.13), hsl(var(--primary) / 0.08));
          box-shadow: inset 0 1px 0 hsl(var(--background) / 0.35), 0 1px 2px hsl(var(--foreground) / 0.06);
          color: hsl(var(--primary));
          font-size: 13px;
          font-weight: 550;
          line-height: 1.35;
          white-space: nowrap;
          text-overflow: ellipsis;
          user-select: none;
          transition: border-color 120ms ease, background-color 120ms ease, box-shadow 120ms ease;
        }
        .session-mention-label {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .session-mention-remove {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 20px;
          height: 20px;
          flex: 0 0 20px;
          margin: -2px -5px -2px 0;
          padding: 0;
          border: 0;
          border-radius: 4px;
          color: inherit;
          background: transparent;
          font-size: 15px;
          font-weight: 500;
          line-height: 1;
          opacity: 0.65;
          cursor: pointer;
        }
        .session-mention-remove:hover,
        .session-mention-remove:focus-visible {
          background: hsl(var(--primary) / 0.16);
          opacity: 1;
        }
        .session-mention-remove:focus-visible {
          outline: 2px solid currentColor;
          outline-offset: -2px;
        }
        .session-mention-chip:hover {
          border-color: hsl(var(--primary) / 0.34);
          background: linear-gradient(180deg, hsl(var(--primary) / 0.18), hsl(var(--primary) / 0.11));
          box-shadow: inset 0 1px 0 hsl(var(--background) / 0.4), 0 2px 5px hsl(var(--foreground) / 0.08);
        }
        .session-mention-chip::before {
          content: '';
          display: inline-block;
          width: 15px;
          height: 15px;
          flex: 0 0 15px;
          background-color: currentColor;
          mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'/%3E%3Cpath d='M8 9h8'/%3E%3Cpath d='M8 13h6'/%3E%3C/svg%3E");
          mask-position: center;
          mask-size: 15px 15px;
          mask-repeat: no-repeat;
          opacity: 0.9;
        }
      `}</style>
    </div>
  )
})
