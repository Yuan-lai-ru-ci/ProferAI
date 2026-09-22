/**
 * AI Elements - 消息组件原语
 *
 * 简化迁移自 profer-frontend 的 ai-elements/message.tsx，
 * 保留核心消息展示组件，适配 Electron + Jotai 架构。
 *
 * 包含：
 * - Message — 根容器，`from` 属性区分 user/assistant
 * - MessageHeader — 头像 + 模型名
 * - MessageContent — 内容区域
 * - MessageActions — 操作按钮容器
 * - MessageAction — 单个操作按钮（可选 Tooltip）
 * - MessageResponse — react-markdown 渲染
 * - UserMessageContent — 长文本自动折叠
 * - MessageLoading — 3 个弹跳点加载动画
 * - MessageStopped — "已停止生成" 状态标记
 * - StreamingIndicator — 流式呼吸脉冲点
 */

import * as React from 'react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { ChevronDown, ChevronUp, Paperclip, FileText, Sparkles, Server, Download, MessageSquareText, Link2, Copy, Check, ListChecks, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { shouldInspectMermaidCodeBlock, shouldRenderMermaidCodeBlock } from '@/lib/mermaid-detection'
import { normalizeLatexDelimiters } from '@/lib/normalize-latex'
import { normalizeMarkdownEmphasisWhitespace } from '@/lib/normalize-markdown-emphasis'
import { getFileBaseName } from '@/lib/file-utils'
import { Button } from '@/components/ui/button'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { LoadingIndicator } from '@/components/ui/loading-indicator'
import { CodeBlock, MermaidBlock } from '@profer/ui'
import { detectLanguage } from '@profer/core'
import { FilePathChip, isAbsoluteFilePath, isRelativeFilePath } from './file-path-chip'
import { useFileAccessSessionId } from './file-access-context'
import { useOpenPreview } from '@/components/diff/preview-opener'
import type { HTMLAttributes, ComponentProps, ReactNode } from 'react'
import type { FileAttachment } from '@profer/shared'
import {
  findAgentSelectionToolbarAnchor,
  parseAgentMarkdownBlocks,
  selectAgentBlockRange,
  serializeAgentBlock,
  serializeAgentSelection,
  toggleAgentBlockSelection,
  type AgentBlockSelectionUpdate,
  type AgentMarkdownBlock,
} from './agent-block-copy'

// ===== Message 根容器 =====

type MessageRole = 'user' | 'assistant' | 'system'

interface MessageProps extends HTMLAttributes<HTMLDivElement> {
  /** 消息发送者角色 */
  from: MessageRole
}

/** 消息根容器，user 自动右对齐 */
export function Message({ className, from, ...props }: MessageProps): React.ReactElement {
  return (
    <div
      className={cn(
        'message-item group flex w-full flex-col gap-0.5 rounded-[10px] px-2.5 py-2.5',
        from === 'user' ? 'is-user' : 'is-assistant',
        className
      )}
      {...props}
    />
  )
}

// ===== MessageHeader 头像 + 模型名 =====

interface MessageHeaderProps extends HTMLAttributes<HTMLDivElement> {
  /** 模型名称 */
  model?: string
  /** 头像元素 */
  logo?: ReactNode
  /** 消息时间戳 */
  time?: string
}

/** 消息头部（user 时自动隐藏） */
export function MessageHeader({
  model,
  logo,
  time,
  className,
  children,
  ...props
}: MessageHeaderProps): React.ReactElement {
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 mb-2.5',
        'group-[.is-user]:hidden',
        className
      )}
      {...props}
    >
      {logo && (
        <div className="flex size-[35px] shrink-0 items-center justify-center overflow-hidden rounded-[25%]">
          {logo}
        </div>
      )}
      <div className="flex flex-col justify-between h-[35px]">
        {model && <span className="message-header-model text-sm font-semibold text-foreground/60 leading-none">{model}</span>}
        {time && <span className="message-time text-[10px] text-foreground/[0.38] leading-none">{time}</span>}
      </div>
      {children}
    </div>
  )
}

// ===== MessageContent 内容区域 =====

type MessageContentProps = HTMLAttributes<HTMLDivElement>

/**
 * 消息内容区域
 * - user 消息：pl-[46px] 与头像对齐 + 浅色气泡背景
 * - assistant 消息：pl-[46px] 与头像对齐
 */
export function MessageContent({
  children,
  className,
  ...props
}: MessageContentProps): React.ReactElement {
  return (
    <div
      className={cn(
        'message-content flex max-w-full min-w-0 flex-col gap-2 overflow-visible pl-[46px]',
        'group-[.is-user]:text-foreground group-[.is-user]:items-start',
        'group-[.is-assistant]:w-full group-[.is-assistant]:text-foreground',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

// ===== MessageActions 操作按钮容器 =====

type MessageActionsProps = ComponentProps<'div'>

/** 操作按钮容器（复制、删除等），默认显示淡色，hover 时加深 */
export function MessageActions({
  className,
  children,
  ...props
}: MessageActionsProps): React.ReactElement {
  return (
    <div
      className={cn(
        'message-actions flex items-center gap-2.5 text-muted-foreground/60 hover:text-muted-foreground/90 transition-colors duration-200',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

// ===== MessageAction 单个操作按钮 =====

interface MessageActionProps extends ComponentProps<typeof Button> {
  /** 悬停提示文字 */
  tooltip?: string
  /** 无障碍标签 */
  label?: string
}

/** 单个操作按钮（含可选 Tooltip 包装） */
export function MessageAction({
  tooltip,
  children,
  label,
  variant = 'ghost',
  size = 'icon-sm',
  ...props
}: MessageActionProps): React.ReactElement {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  )

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return button
}

// ===== MessageResponse Markdown 渲染 =====

// ----- mdast 节点类型（remark 自定义插件用） -----

interface MdastTextNode {
  type: 'text'
  value: string
}

interface MdastLinkNode {
  type: 'link'
  url: string
  children: MdastNode[]
}

interface MdastBreakNode {
  type: 'break'
}

interface MdastGenericNode {
  type: string
  children?: MdastNode[]
  value?: string
}

type MdastNode = MdastTextNode | MdastLinkNode | MdastBreakNode | MdastGenericNode

interface MdastParent {
  type: string
  children: MdastNode[]
}

// ----- mdast 工具函数 -----

/** 递归遍历 mdast text 节点（自动跳过 code / inlineCode 子树） */
function walkMdastText(
  node: MdastParent,
  visitor: (node: MdastTextNode, index: number, parent: MdastParent) => number | void
): void {
  if (!node.children) return
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]!
    if (child.type === 'text') {
      const result = visitor(child as MdastTextNode, i, node)
      if (typeof result === 'number') i = result - 1
    } else if (child.type !== 'code' && child.type !== 'inlineCode') {
      const asParent = child as MdastParent
      if (asParent.children) walkMdastText(asParent, visitor)
    }
  }
}

// ----- MentionChip 组件 -----

type MentionType = 'file' | 'skill' | 'mcp' | 'session'

const MENTION_STYLES: Record<MentionType, { icon: typeof FileText; className: string }> = {
  file: { icon: FileText, className: 'bg-primary/10 text-primary' },
  skill: { icon: Sparkles, className: 'bg-[hsl(270_60%_60%/0.15)] text-[hsl(270_60%_50%)]' },
  mcp: { icon: Server, className: 'bg-[hsl(160_60%_45%/0.15)] text-[hsl(160_60%_35%)]' },
  session: { icon: MessageSquareText, className: 'bg-[hsl(200_80%_50%/0.14)] text-[hsl(200_80%_40%)]' },
}

function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function MentionChip({ type, value }: { type: MentionType; value: string }): React.ReactElement {
  const style = MENTION_STYLES[type]
  const Icon = style.icon
  const decoded = safeDecode(value)
  const display = type === 'file'
    ? getFileBaseName(decoded)
    : type === 'session'
      ? `会话 ${decoded.slice(0, 8)}`
      : decoded
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded px-1 py-[1px] text-[13px] font-medium whitespace-nowrap align-baseline',
        style.className
      )}
      title={type === 'file' || type === 'session' ? decoded : undefined}
    >
      <Icon className="size-3 inline shrink-0" />
      {display}
    </span>
  )
}

// ----- remarkMentions：将 @file: /skill: #mcp: &session: 转为 mention:// link 节点 -----

export function remarkMentions() {
  return (tree: MdastParent) => {
    walkMdastText(tree, (node, index, parent) => {
      const text = node.value
      // 每次调用创建独立正则实例，避免 /g 状态在并发 remark pipeline 间互相干扰
      const mentionPattern = /@file:(\S+)|\/skill:(\S+)|#mcp:(\S+)|&session:(\S+)/g
      if (!mentionPattern.test(text)) return
      mentionPattern.lastIndex = 0

      const parts: MdastNode[] = []
      let lastIdx = 0
      let m: RegExpExecArray | null

      while ((m = mentionPattern.exec(text)) !== null) {
        if (m.index > lastIdx) {
          parts.push({ type: 'text', value: text.slice(lastIdx, m.index) })
        }
        const mType: MentionType = m[1] ? 'file' : m[2] ? 'skill' : m[3] ? 'mcp' : 'session'
        const mValue = m[1] ?? m[2] ?? m[3] ?? m[4] ?? ''
        // 新版 htmlToMarkdown 已 encodeURIComponent，旧消息是原始路径
        const alreadyEncoded = /%[0-9A-Fa-f]{2}/.test(mValue)
        const safeValue = alreadyEncoded ? mValue : encodeURIComponent(mValue)
        parts.push({
          type: 'link',
          url: `mention://${mType}/${safeValue}`,
          children: [{ type: 'text', value: m[0] }],
        })
        lastIdx = m.index + m[0].length
      }

      if (lastIdx < text.length) {
        parts.push({ type: 'text', value: text.slice(lastIdx) })
      }

      parent.children.splice(index, 1, ...parts)
      return index + parts.length
    })
  }
}

// ----- remarkPreserveBreaks：在 text 节点中将 \n 转为 break 节点（跳过代码块） -----

export function remarkPreserveBreaks() {
  return (tree: MdastParent) => {
    walkMdastText(tree, (node, index, parent) => {
      const text = node.value
      if (!text.includes('\n')) return

      const lines = text.split('\n')
      const parts: MdastNode[] = []

      for (let i = 0; i < lines.length; i++) {
        if (i > 0) parts.push({ type: 'break' })
        if (lines[i]) parts.push({ type: 'text', value: lines[i] })
      }

      parent.children.splice(index, 1, ...parts)
      return index + parts.length
    })
  }
}

/** remark 插件函数签名 */
export type RemarkPluginFn = () => (tree: MdastParent) => void

// ----- remarkWikilinks：将 [[名称]] 双链转为 wikilink:// 链接节点 -----
// 用于记忆面板等支持 Obsidian 式双链的富文本预览：Article 正文里写 [[security-encryption]]
// 会被渲染为可点击的双链，点击后在面板内跳转到对应记忆文件。
const WIKILINK_PATTERN = /\[\[([^\[\]|]+?)(?:\|([^\[\]]*?))?\]\]/g

/**
 * 把 [[名称]]（可选 [[名称|显示文本]]）转成 wikilink://<encodedName> 链接节点。
 * 调用方（记忆面板）通过 MessageResponse 的 remarkPlugins 按需启用，避免影响全局消息渲染。
 */
export function remarkWikilinks() {
  return (tree: MdastParent) => {
    walkMdastText(tree, (node, index, parent) => {
      const text = node.value
      if (!WIKILINK_PATTERN.test(text)) return
      WIKILINK_PATTERN.lastIndex = 0

      const parts: MdastNode[] = []
      let lastIdx = 0
      let m: RegExpExecArray | null

      while ((m = WIKILINK_PATTERN.exec(text)) !== null) {
        if (m.index > lastIdx) parts.push({ type: 'text', value: text.slice(lastIdx, m.index) })
        const target = m[1]!.trim()
        const label = (m[2] || m[1]!).trim()
        const safeValue = encodeURIComponent(target)
        parts.push({
          type: 'link',
          url: `wikilink://${safeValue}`,
          children: [{ type: 'text', value: label }],
        })
        lastIdx = m.index + m[0].length
      }
      if (lastIdx < text.length) parts.push({ type: 'text', value: text.slice(lastIdx) })

      parent.children.splice(index, 1, ...parts)
      return index + parts.length
    })
  }
}

// ----- remarkTableSource：为 GFM 表格注入原始 Markdown 源码 -----
// 通过 mdast 节点的 position（相对预处理后字符串的 offset）slice 出每个表格的精确源码，
// 写入 data.hProperties，由 remark-rehype 透传给 table 组件，供「复制为 Markdown 源码」使用。

interface MdastTableNode extends MdastParent {
  type: 'table'
  position?: { start?: { offset?: number }; end?: { offset?: number } }
  data?: { hProperties?: Record<string, unknown> }
}

export function remarkTableSource(source: string): RemarkPluginFn {
  return () => (tree: MdastParent) => {
    const visit = (node: MdastNode): void => {
      const generic = node as MdastGenericNode
      if (generic.type === 'table') {
        const table = generic as MdastTableNode
        const start = table.position?.start?.offset
        const end = table.position?.end?.offset
        if (start != null && end != null && end > start) {
          const raw = source.slice(start, end)
          const data = table.data ?? {}
          data.hProperties = { ...(data.hProperties ?? {}), 'data-table-source': raw }
          table.data = data
        }
      }
      if (generic.children) {
        for (const child of generic.children) visit(child)
      }
    }
    for (const child of tree.children ?? []) visit(child)
  }
}

const BasePathsContext = React.createContext<string[] | undefined>(undefined)

/** 双链（[[...]]）点击处理：由记忆面板等启用双链的宿主提供，跳到对应记忆文件 */
type WikilinkClickHandler = (name: string) => void
const WikilinkClickContext = React.createContext<WikilinkClickHandler | undefined>(undefined)

/** 提供双链点击处理器（记忆面板用；不提供则 wikilink 渲染为不可点击文本） */
export function WikilinkClickProvider({ onClick, children }: { onClick: WikilinkClickHandler; children: React.ReactNode }): React.ReactElement {
  return <WikilinkClickContext.Provider value={onClick}>{children}</WikilinkClickContext.Provider>
}

/** 提供附加目录候选给所有内嵌的 MessageResponse */
export function BasePathsProvider({ basePaths, children }: { basePaths?: string[]; children: React.ReactNode }): React.ReactElement {
  return <BasePathsContext.Provider value={basePaths}>{children}</BasePathsContext.Provider>
}

/**
 * 本轮「文件名 → 绝对路径」映射上下文 — 由 AssistantTurnRenderer 提供，作用域为单个 turn。
 * 正文里的内联文件引用通常只有裸文件名（如 `user-profile.md`）；命中本轮实际触及文件的
 * 映射时，MarkdownInlineCode 会补全绝对路径，让它与底部文件 chip 走同一条可靠解析链路。
 */
const TurnFileMapContext = React.createContext<Map<string, string> | undefined>(undefined)

/** 提供本轮文件名→绝对路径映射给所有内嵌的 MessageResponse */
export function TurnFileMapProvider({ map, children }: { map?: Map<string, string>; children: React.ReactNode }): React.ReactElement {
  return <TurnFileMapContext.Provider value={map}>{children}</TurnFileMapContext.Provider>
}

interface MessageResponseProps {
  /** Markdown 内容 */
  children: string
  /** 流式阶段使用稳定的纯文本布局，避免未闭合 Markdown 语法反复改变 DOM 结构。 */
  streaming?: boolean
  className?: string
  /** 基础目录路径，用于解析相对文件路径（如 Agent 会话工作目录） */
  basePath?: string
  /** 额外的基础目录候选（如附加目录），点击 chip 时由主进程依次解析 */
  basePaths?: string[]
  /** 额外的 remark 插件（追加到内置 remarkGfm + remarkMath 之后） */
  remarkPlugins?: RemarkPluginFn[]
  /** Agent 回答/已展开思考内容启用块级复制与多选。 */
  enableBlockCopy?: boolean
}

/** 稳定引用的插件数组，避免 react-markdown 每帧重建插件管线 */
const REMARK_PLUGINS = [remarkGfm, remarkMath]
// Agent 输出偶尔会把中文说明或标点放入数学分隔符；这类 KaTeX strict 警告不影响渲染，
// 且在流式更新时会重复刷屏，因此仅对 Markdown 消息关闭该诊断。
const REHYPE_PLUGINS: NonNullable<React.ComponentProps<typeof Markdown>['rehypePlugins']> = [
  [rehypeKatex, { strict: 'ignore' }],
]

/**
 * 仅将本机 file:// URL 转为系统路径；拒绝 file://server/share 等远程主机形式。
 * 路径最终仍由主进程的 FileAccessOptions 校验，不在 renderer 放宽文件访问边界。
 */
export function localFileUrlToPath(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:' || (parsed.hostname && parsed.hostname !== 'localhost')) return null
    const pathname = decodeURIComponent(parsed.pathname)
    if (!pathname) return null
    // file:///C:/... 在 Windows URL 规范里有一个额外的前导斜杠。
    return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname
  } catch {
    return null
  }
}

/** 允许 mention:// 与 wikilink:// 以及安全的本机 file:// 协议通过 URL 清洗。 */
function mentionUrlTransform(url: string): string {
  if (url.startsWith('mention://') || url.startsWith('wikilink://') || localFileUrlToPath(url)) return url
  return defaultUrlTransform(url)
}

/** wikilink:// URL 匹配 */
const WIKILINK_URL_RE = /^wikilink:\/\/(.+)$/

// ===== Memo'd Markdown 子组件（稳定引用，避免 react-markdown 每帧重建组件映射） =====

/** mention:// URL 匹配 */
const MENTION_URL_RE = /^mention:\/\/(file|skill|mcp|session)\/(.+)$/

/** 外部链接 / mention chip 渲染器 */
const MarkdownLink = React.memo(function MarkdownLink({
  href,
  children: linkChildren,
  ...linkProps
}: React.AnchorHTMLAttributes<HTMLAnchorElement>): React.ReactElement {
  const ctxBasePaths = React.useContext(BasePathsContext)
  const sessionId = useFileAccessSessionId()
  const openPreview = useOpenPreview()
  const onWikilinkClick = React.useContext(WikilinkClickContext)

  // mention:// 协议 → 渲染为 MentionChip
  if (href) {
    const mentionMatch = MENTION_URL_RE.exec(href)
    if (mentionMatch) {
      return <MentionChip type={mentionMatch[1] as MentionType} value={mentionMatch[2] ?? ''} />
    }
    const wikilinkMatch = WIKILINK_URL_RE.exec(href)
    if (wikilinkMatch) {
      const name = safeDecode(wikilinkMatch[1] ?? '')
      return (
        <span
          role="link"
          tabIndex={onWikilinkClick ? 0 : -1}
          onClick={(e) => {
            e.preventDefault(); e.stopPropagation()
            if (!onWikilinkClick) return
            onWikilinkClick(name)
          }}
          onKeyDown={(e) => {
            if (onWikilinkClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onWikilinkClick(name) }
          }}
          className="inline-flex cursor-pointer items-center gap-0.5 rounded px-1 py-[1px] align-baseline text-[13px] font-medium text-primary underline decoration-primary/40 underline-offset-2 transition-colors hover:bg-primary/10"
          title={`跳转到记忆：${name}`}
        >
          <Link2 className="size-3 inline shrink-0" />
          {name}
        </span>
      )
    }
  }

  const link = (
    <a
      {...linkProps}
      href={href}
      onClick={(e) => {
        e.preventDefault()
        if (!href) return
        if (href.startsWith('http://') || href.startsWith('https://')) {
          window.electronAPI.openExternal(href)
          return
        }

        const filePathFromUrl = localFileUrlToPath(href)
        if (filePathFromUrl) {
          // Markdown 的 [标题](file://...) 链接也走统一预览路径，避免跳到空白页面。
          // 主进程会用 sessionId 与 FileAccessOptions 保持既有安全校验。
          if (sessionId) {
            openPreview(sessionId, {
              filePath: filePathFromUrl,
              dirPath: ctxBasePaths?.[0],
              previewOnly: true,
              readOnly: true,
              basePaths: ctxBasePaths,
            })
          }
        } else if (sessionId && (/^[A-Za-z]:[\\/]/.test(href) || href.startsWith('/') || href.startsWith('~') || href.startsWith('.'))) {
          // 有来源会话时统一走受授权的预览入口；无来源会话 fail closed。
          openPreview(sessionId, {
            filePath: href,
            dirPath: ctxBasePaths?.[0],
            previewOnly: true,
            readOnly: true,
            basePaths: ctxBasePaths,
          })
        }
      }}
      title={href}
    >
      {linkChildren}
    </a>
  )

  return link
})

/** 递归提取纯文本（children 可能是字符串数组） */
function extractText(node: React.ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (!node) return ''
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (React.isValidElement(node)) {
    return extractText((node.props as { children?: React.ReactNode }).children)
  }
  return ''
}

/** 代码块 / Mermaid 渲染器 */
const MarkdownPre = React.memo(function MarkdownPre({
  children: preChildren,
}: { children?: React.ReactNode }): React.ReactElement {
  // react-markdown v10 把 <code> 替换成自定义组件后，type 不再是字符串 'code'，
  // 但 pre 的 code child 要么是原生 'code'（v9 及之前），要么是自定义函数/对象组件（v10+）。
  // 通过 type 形态过滤掉意外混入的其他原生 HTML 元素（如 span/div），降低未来 react-markdown
  // 行为变化导致静默误识别的风险
  const codeChild = React.Children.toArray(preChildren).find(
    (child): child is React.ReactElement => {
      if (!React.isValidElement(child)) return false
      const t = (child as React.ReactElement).type
      return t === 'code' || typeof t === 'function' || typeof t === 'object'
    }
  ) as React.ReactElement | undefined

  if (codeChild) {
    const codeProps = codeChild.props as { className?: string; children?: React.ReactNode }
    const className = codeProps.className ?? ''
    const hasExplicitLang = /\blanguage-\S+/.test(className)

    // 先用共享 mermaid 识别（覆盖 language-mermaid/mmd 以及未标语言但内容像 Mermaid 的情况）
    if (shouldInspectMermaidCodeBlock(className)) {
      // normalize Windows/legacy-Mac line endings before feeding to Mermaid parser
      const mermaidCode = extractText(codeProps.children).replace(/\r\n?/g, '\n').replace(/\n$/, '')
      if (shouldRenderMermaidCodeBlock(className, mermaidCode)) {
        return <MermaidBlock code={mermaidCode} />
      }
    }

    // 未标注语言且非 Mermaid 时：highlight.js 自动检测，命中后注入 language-xxx 喂给 CodeBlock 高亮
    if (!hasExplicitLang) {
      const rawCode = extractText(codeProps.children).replace(/\n$/, '')
      const detected = detectLanguage(rawCode)
      if (detected !== 'text') {
        const patchedCode = React.cloneElement(codeChild, {
          className: `${className} language-${detected}`.trim(),
        } as Partial<React.HTMLAttributes<HTMLElement>>)
        return <CodeBlock>{patchedCode}</CodeBlock>
      }
    }
  }

  return <CodeBlock>{preChildren}</CodeBlock>
})

// ===== MarkdownTable 表格渲染 + 复制 =====

/** 从 react-markdown 渲染后的表格 children 提取二维纯文本（thead/tbody → tr → th/td） */
export function parseTableChildren(children: React.ReactNode): string[][] {
  const rows: string[][] = []
  React.Children.forEach(children, (section) => {
    if (!React.isValidElement(section)) return
    const sectionType = typeof section.type === 'string' ? section.type : ''
    if (sectionType !== 'thead' && sectionType !== 'tbody') return
    React.Children.forEach((section.props as { children?: React.ReactNode }).children, (row) => {
      if (!React.isValidElement(row) || row.type !== 'tr') return
      const cells: string[] = []
      React.Children.forEach((row.props as { children?: React.ReactNode }).children, (cell) => {
        if (!React.isValidElement(cell)) return
        const cellType = typeof cell.type === 'string' ? cell.type : ''
        if (cellType !== 'th' && cellType !== 'td') return
        cells.push(extractText((cell.props as { children?: React.ReactNode }).children))
      })
      if (cells.length > 0) rows.push(cells)
    })
  })
  return rows
}

/** 二维数组 → TSV（制表符分隔），单元格内换行折叠为空格 */
export function rowsToTsv(rows: string[][]): string {
  return rows
    .map((row) => row.map((cell) => cell.replace(/\s*\n\s*/g, ' ')).join('\t'))
    .join('\n')
}

/** 二维数组 → Markdown 表格源码（兜底：无精确源码时用纯文本重建） */
export function rowsToMarkdown(rows: string[][]): string {
  if (rows.length === 0) return ''
  const header = rows[0]!
  const escape = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const lines: string[] = [
    `| ${header.map(escape).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
  ]
  for (const row of rows.slice(1)) {
    lines.push(`| ${Array.from({ length: header.length }, (_, i) => escape(row[i] ?? '')).join(' | ')} |`)
  }
  return lines.join('\n')
}

/** 多选块点击时不应把内容交互误判为块选择。 */
const AGENT_BLOCK_INTERACTION_SELECTOR = 'a,button,input,textarea,select,img,[role="button"],[role="img"]'

/** Markdown 图片渲染器。 */
const MarkdownImage = React.memo(function MarkdownImage({ src, alt }: React.ImgHTMLAttributes<HTMLImageElement>): React.ReactElement {
  const sessionId = useFileAccessSessionId()
  const basePaths = React.useContext(BasePathsContext)
  const [resolvedSrc, setResolvedSrc] = React.useState<string>()

  React.useEffect(() => {
    if (!src || !sessionId) return
    const filePath = localFileUrlToPath(src) ?? src
    if (/^(https?:|data:|blob:)/.test(src)) {
      setResolvedSrc(src)
      return
    }
    let active = true
    window.electronAPI.resolveFilePath(filePath, {
      sessionId,
      candidateBasePaths: basePaths,
    }).then((result) => {
      if (active) setResolvedSrc(result?.url)
    }).catch(() => {})
    return () => { active = false }
  }, [basePaths, sessionId, src])

  return resolvedSrc ? <img src={resolvedSrc} alt={alt} /> : <span role="img" aria-label={alt} />
})

/** GFM 表格本身只负责布局；复制与格式选择由外层块右上角统一操作条提供。 */
const MarkdownTable = React.memo(function MarkdownTable(
  props: { children?: React.ReactNode }
): React.ReactElement {
  return (
    <div className="my-3">
      <div className="overflow-x-auto">
        <table className="my-0">{props.children}</table>
      </div>
    </div>
  )
})

/** 行内代码 / 文件路径渲染器 */
const MarkdownInlineCode = React.memo(function MarkdownInlineCode({
  children: codeChildren,
  className: codeClassName,
  basePath,
  basePaths,
  ...codeProps
}: React.HTMLAttributes<HTMLElement> & { basePath?: string; basePaths?: string[] }): React.ReactElement {
  // 兜底：从 context 读附加 basePaths（避免穿透 SDKMessageRenderer / ContentBlock 等中间层）
  const ctxBasePaths = React.useContext(BasePathsContext)
  // 本轮实际触及的「文件名 → 绝对路径」映射，解决正文里裸文件名无法可靠定位的问题。
  const turnFileMap = React.useContext(TurnFileMapContext)
  if (codeClassName) {
    return <code className={codeClassName} {...codeProps}>{codeChildren}</code>
  }

  const text = typeof codeChildren === 'string' ? codeChildren : ''

  if (text) {
    // 合并 basePath（主 cwd）+ basePaths（props 或 context 提供的附加目录）作为候选
    const merged: string[] = []
    if (basePath) merged.push(basePath)
    const allExtra = basePaths || ctxBasePaths
    if (allExtra) {
      for (const p of allExtra) {
        if (p && !merged.includes(p)) merged.push(p)
      }
    }
    if (isAbsoluteFilePath(text)) {
      return <FilePathChip filePath={text.trim()} basePaths={merged.length > 0 ? merged : undefined} />
    }
    if (merged.length > 0 && isRelativeFilePath(text)) {
      // 裸文件名命中本轮工具实际访问过的路径时，补成绝对路径；同名冲突会从映射中移除，
      // 因此未命中时继续走既有 basePaths 降级解析，不会误打开别的同名文件。
      const trimmed = text.trim()
      if (turnFileMap && turnFileMap.size > 0) {
        const lineColMatch = trimmed.match(/^(.+?)(:\d+(?::\d+)?)$/)
        const hasLineCol = !!lineColMatch && !lineColMatch[1]!.endsWith(':')
        const pathPart = hasLineCol ? lineColMatch![1]! : trimmed
        const suffix = hasLineCol ? lineColMatch![2]! : ''
        const baseName = getFileBaseName(pathPart)
        const absolutePath = turnFileMap.get(baseName)
        if (absolutePath) {
          return <FilePathChip filePath={absolutePath + suffix} basePaths={merged} />
        }
      }
      return <FilePathChip filePath={trimmed} basePaths={merged} />
    }
  }

  return (
    <code
      className="rounded bg-foreground/10 px-[0.35em] py-[0.15em] text-[0.875em] font-mono font-medium"
      {...codeProps}
    >
      {codeChildren}
    </code>
  )
})

interface AgentBlockMargin {
  className: string
  topRank: number
  bottomRank: number
  topBridgeClassName: string
  bottomBridgeClassName: string
}

function listBlockSignature(block: AgentMarkdownBlock | undefined): string | null {
  if (!block) return null
  const match = /^(?:([-+*])|(\d+)([.)]))(?:\s|$)/.exec(block.source.trimStart())
  if (!match) return null
  return match[1] ? `unordered:${match[1]}` : `ordered:${match[3]}`
}

function isFenceBlock(block: AgentMarkdownBlock | undefined): boolean {
  return Boolean(block && /^(?:`{3,}|~{3,})/.test(block.source.trimStart()))
}

/** 保留块在原始 prose 容器中的纵向节奏，包括列表邻接与连续代码块间距。 */
function agentBlockMargin(block: AgentMarkdownBlock, previous?: AgentMarkdownBlock, next?: AgentMarkdownBlock): AgentBlockMargin {
  const source = block.source.trimStart()
  const listSignature = listBlockSignature(block)
  if (listSignature) {
    const joinsPrevious = listBlockSignature(previous) === listSignature
    const joinsNext = listBlockSignature(next) === listSignature
    return {
      className: cn(joinsPrevious ? 'mt-0' : 'mt-[1.25em]', joinsNext ? 'mb-0' : 'mb-[1.25em]'),
      topRank: joinsPrevious ? 0 : 18.75,
      bottomRank: joinsNext ? 0 : 18.75,
      topBridgeClassName: joinsPrevious ? 'bottom-0' : '-bottom-[1.25em]',
      bottomBridgeClassName: joinsNext ? 'bottom-0' : '-bottom-[1.25em]',
    }
  }
  if (/^>/.test(source)) return { className: 'my-[1.6em]', topRank: 24, bottomRank: 24, topBridgeClassName: '-bottom-[1.6em]', bottomBridgeClassName: '-bottom-[1.6em]' }
  if (isFenceBlock(block)) {
    const followsFence = isFenceBlock(previous)
    return { className: followsFence ? 'mt-4 mb-0' : 'my-0', topRank: followsFence ? 16 : 0, bottomRank: 0, topBridgeClassName: followsFence ? '-bottom-4' : 'bottom-0', bottomBridgeClassName: 'bottom-0' }
  }
  if (block.kind === 'table' || /^(?:[-*_]\s*){3,}$/.test(source.split('\n', 1)[0] ?? '')) return { className: 'my-3', topRank: 12, bottomRank: 12, topBridgeClassName: '-bottom-3', bottomBridgeClassName: '-bottom-3' }
  if (/^(?:#{1,6}\s|[^\n]+\n(?:=+|-+)\s*$)/.test(source)) return { className: 'my-2', topRank: 8, bottomRank: 8, topBridgeClassName: '-bottom-2', bottomBridgeClassName: '-bottom-2' }
  return { className: 'my-1.5', topRank: 6, bottomRank: 6, topBridgeClassName: '-bottom-1.5', bottomBridgeClassName: '-bottom-1.5' }
}

/** 使用 react-markdown 渲染 assistant 消息内容，代码块使用 Shiki 语法高亮 */
interface CopyableMarkdownBlockProps {
  block: AgentMarkdownBlock
  components: React.ComponentProps<typeof Markdown>['components']
  remarkPlugins: NonNullable<React.ComponentProps<typeof Markdown>['remarkPlugins']>
  selected: boolean
  selectedBefore: boolean
  selectedAfter: boolean
  selecting: boolean
  toolbarVisible: boolean
  toolbarBlock: AgentMarkdownBlock | null
  toolbarBlockSelected: boolean
  marginClassName: string
  selectionBridgeAfterClassName: string
  markdownFormat: 'markdown' | 'plainText'
  onSelect: (event: React.MouseEvent<HTMLDivElement>) => void
  onHover: () => void
  onToolbarEnter: () => void
  onToolbarLeave: () => void
  toolbarExpanded: boolean
  previewVisible: boolean
  onCopy: () => void
  onEnterSelection: (event: React.MouseEvent<HTMLButtonElement>) => void
  onExitSelection: (event: React.MouseEvent<HTMLButtonElement>) => void
  onMarkdownFormatChange: (format: 'markdown' | 'plainText') => void
  tableFormat: 'markdown' | 'tsv'
  onTableFormatChange: (format: 'markdown' | 'tsv') => void
  selectionFormatMode: 'markdown' | 'plainText' | 'tsv' | 'mixed'
  copied: boolean
}

function CopyableMarkdownBlock({ block, components, remarkPlugins, selected, selectedBefore, selectedAfter, selecting, toolbarVisible, toolbarBlock, toolbarBlockSelected, marginClassName, selectionBridgeAfterClassName, markdownFormat, onSelect, onHover, onToolbarEnter, onToolbarLeave, toolbarExpanded, previewVisible, onCopy, onEnterSelection, onExitSelection, onMarkdownFormatChange, tableFormat, onTableFormatChange, selectionFormatMode, copied }: CopyableMarkdownBlockProps): React.ReactElement {
  const selectionGroupStart = selected && !selectedBefore
  const selectionGroupEnd = selected && !selectedAfter
  const selectionPaddingClassName = selected
    ? cn(selectionGroupStart && 'pt-2', selectionGroupEnd && 'pb-2')
    : undefined
  const selectionFrameClassName = selected
    ? cn(
        'pointer-events-none absolute -inset-x-1 top-0 z-0 border-x-[3px] border-primary/60 bg-primary/[0.06]',
        selectionGroupStart && 'rounded-t-md border-t-[3px]',
        selectionGroupEnd ? 'bottom-0 rounded-b-md border-b-[3px]' : selectionBridgeAfterClassName,
      )
    : previewVisible
      ? 'pointer-events-none absolute -inset-x-1 inset-y-0 z-0 rounded-md border-2 border-dashed border-primary/40 bg-primary/[0.025]'
      : undefined
  return (
    <div
      className={cn('group/agent-block relative transition-[padding,colors] duration-100', marginClassName, selectionPaddingClassName, selected && 'is-selected')}
      data-agent-block-id={block.id}
      onClick={onSelect}
      onMouseEnter={onHover}
    >
      {selectionFrameClassName && <div aria-hidden="true" className={selectionFrameClassName} />}
      {toolbarVisible && toolbarBlock && (
        <div
          data-agent-toolbar-block-id={toolbarBlock.id}
          data-agent-toolbar-corridor="true"
          className="pointer-events-auto absolute -right-1 -top-9 z-20 flex h-9 items-end pb-0.5"
          onMouseEnter={onToolbarEnter}
          onMouseLeave={onToolbarLeave}
        >
          <div className="flex items-center gap-0.5 rounded-md border border-border/60 bg-background/95 px-0.5 py-0.5 shadow-sm" onClick={(event) => event.stopPropagation()}>
            {toolbarBlock.kind === 'markdown' && (selecting || toolbarExpanded) && (selectionFormatMode === 'markdown' || selectionFormatMode === 'plainText') && (
              <div className="flex items-center rounded bg-muted/70 p-0.5 text-xs">
                <button type="button" className={cn('rounded px-1.5 py-0.5', markdownFormat === 'markdown' && 'bg-background shadow-sm')} onClick={() => onMarkdownFormatChange('markdown')}>Markdown</button>
                <button type="button" className={cn('rounded px-1.5 py-0.5', markdownFormat === 'plainText' && 'bg-background shadow-sm')} onClick={() => onMarkdownFormatChange('plainText')}>纯文本</button>
              </div>
            )}
            {toolbarBlock.kind === 'table' && (selecting || toolbarExpanded) && (selectionFormatMode === 'tsv' || selectionFormatMode === 'markdown') && (
              <div className="flex items-center rounded bg-muted/70 p-0.5 text-xs">
                <button type="button" className={cn('rounded px-1.5 py-0.5', tableFormat === 'markdown' && 'bg-background shadow-sm')} onClick={() => onTableFormatChange('markdown')}>表格 Markdown</button>
                <button type="button" className={cn('rounded px-1.5 py-0.5', tableFormat === 'tsv' && 'bg-background shadow-sm')} onClick={() => onTableFormatChange('tsv')}>TSV</button>
              </div>
            )}
            {selectionFormatMode === 'mixed' && <span className="px-1 text-xs text-muted-foreground">Markdown</span>}
            <button type="button" aria-label="复制此块" title={selecting ? '复制全部已选块' : '复制此块'} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onCopy}>{copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}</button>
            {!selecting && <button type="button" aria-label="选择此块" title="进入多选" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onEnterSelection}><ListChecks className="size-3.5" /></button>}
            {selecting && <button type="button" aria-label="退出多选" title="退出多选 (Esc)" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onExitSelection}><X className="size-3.5" /></button>}
          </div>
        </div>
      )}
      <div className="relative z-10 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        <Markdown remarkPlugins={remarkPlugins} rehypePlugins={REHYPE_PLUGINS} urlTransform={mentionUrlTransform} components={components}>{block.source}</Markdown>
      </div>
    </div>
  )
}

export const MessageResponse = React.memo(
  function MessageResponse({ children, className, basePath, basePaths, remarkPlugins, streaming = false, enableBlockCopy = false }: MessageResponseProps): React.ReactElement {
    const processed = React.useMemo(() => normalizeMarkdownEmphasisWhitespace(normalizeLatexDelimiters(children.replace(/<!--PROMA_AUTOMATION:[\s\S]*?-->/g, '').trim())), [children])
    const blocks = React.useMemo(() => parseAgentMarkdownBlocks(processed), [processed])
    const [selection, setSelection] = React.useState<AgentBlockSelectionUpdate>({ selectedIds: new Set(), selecting: false })
    const { selectedIds, selecting } = selection
    const [selectionAnchorId, setSelectionAnchorId] = React.useState<string | null>(null)
    const [rangeEstablished, setRangeEstablished] = React.useState(false)
    const [hoveredBlockId, setHoveredBlockId] = React.useState<string | null>(null)
    const [toolbarExpanded, setToolbarExpanded] = React.useState(false)
    const hoverSwitchTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
    const toolbarLeaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
    const [markdownFormat, setMarkdownFormat] = React.useState<'markdown' | 'plainText'>('markdown')
    const [tableFormats, setTableFormats] = React.useState<Map<string, 'markdown' | 'tsv'>>(new Map())

    const exitSelection = React.useCallback(() => {
      setSelection({ selectedIds: new Set(), selecting: false })
      setSelectionAnchorId(null)
      setRangeEstablished(false)
    }, [])

    const clearHoverSwitchTimer = React.useCallback(() => {
      if (hoverSwitchTimerRef.current === null) return
      clearTimeout(hoverSwitchTimerRef.current)
      hoverSwitchTimerRef.current = null
    }, [])

    const clearToolbarLeaveTimer = React.useCallback(() => {
      if (toolbarLeaveTimerRef.current === null) return
      clearTimeout(toolbarLeaveTimerRef.current)
      toolbarLeaveTimerRef.current = null
    }, [])

    React.useEffect(() => {
      exitSelection()
      clearHoverSwitchTimer()
      clearToolbarLeaveTimer()
      setHoveredBlockId(null)
      setToolbarExpanded(false)
    }, [processed, enableBlockCopy, exitSelection, clearHoverSwitchTimer, clearToolbarLeaveTimer])

    React.useEffect(() => () => {
      clearHoverSwitchTimer()
      clearToolbarLeaveTimer()
    }, [clearHoverSwitchTimer, clearToolbarLeaveTimer])

    React.useEffect(() => {
      clearToolbarLeaveTimer()
    }, [clearToolbarLeaveTimer, selecting, selectedIds])

    React.useEffect(() => {
      if (!selecting) return
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        exitSelection()
      }
      window.addEventListener('keydown', handleKeyDown, true)
      return () => window.removeEventListener('keydown', handleKeyDown, true)
    }, [exitSelection, selecting])

    const components = React.useMemo(() => ({
      a: MarkdownLink,
      img: MarkdownImage,
      pre: MarkdownPre,
      code: (props: React.HTMLAttributes<HTMLElement>) => <MarkdownInlineCode {...props} basePath={basePath} basePaths={basePaths} />,
      table: MarkdownTable,
    }), [basePath, basePaths])
    const containerClassName = cn('prose dark:prose-invert max-w-none text-[length:var(--md-preview-font-size,15px)]', 'prose-p:my-1.5 prose-p:leading-[1.6] prose-li:leading-[1.6] prose-pre:my-0 prose-headings:my-2 prose-hr:my-3', '[&_.code-block-wrapper+.code-block-wrapper]:mt-4', className)

    const tableFormatFor = React.useCallback((block: AgentMarkdownBlock): 'markdown' | 'tsv' => tableFormats.get(block.id) ?? 'markdown', [tableFormats])
    const updateTableFormat = React.useCallback((blockId: string, format: 'markdown' | 'tsv') => {
      setTableFormats((current) => {
        const next = new Map(current)
        next.set(blockId, format)
        return next
      })
    }, [])
    const [copied, setCopied] = React.useState(false)
    const copiedTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
    const markCopied = React.useCallback(() => {
      setCopied(true)
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = setTimeout(() => {
        copiedTimerRef.current = null
        setCopied(false)
      }, 2000)
    }, [])
    React.useEffect(() => () => {
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current)
    }, [])
    const copyBlock = React.useCallback(async (block: AgentMarkdownBlock) => {
      try {
        await navigator.clipboard.writeText(serializeAgentBlock(block, block.kind === 'table' ? tableFormatFor(block) : markdownFormat))
        markCopied()
      } catch (error) {
        console.error('[MessageResponse] 复制块失败:', error)
      }
    }, [markdownFormat, markCopied, tableFormatFor])
    const copySelected = React.useCallback(async () => {
      const selectedBlocks = blocks.filter((block) => selectedIds.has(block.id))
      if (selectedBlocks.length === 0) return
      const forceMarkdown = selectedBlocks.some((block) => block.kind === 'markdown') && selectedBlocks.some((block) => block.kind === 'table')
      try {
        await navigator.clipboard.writeText(forceMarkdown
          ? selectedBlocks.map((block) => serializeAgentBlock(block, 'markdown')).join('\n\n')
          : serializeAgentSelection({ blocks: selectedBlocks, markdownFormat, tableFormat: 'markdown', tableFormats }))
        markCopied()
      } catch (error) {
        console.error('[MessageResponse] 复制已选内容失败:', error)
      }
    }, [blocks, markdownFormat, markCopied, selectedIds, tableFormats])
    const toggleBlock = React.useCallback((block: AgentMarkdownBlock, event: React.MouseEvent<HTMLDivElement>) => {
      if (!selecting || (event.target as HTMLElement).closest(AGENT_BLOCK_INTERACTION_SELECTOR)) return
      if (!rangeEstablished && selectionAnchorId && selectionAnchorId !== block.id) {
        setSelection({ selectedIds: selectAgentBlockRange(blocks, selectionAnchorId, block.id), selecting: true })
        setRangeEstablished(true)
        return
      }
      setSelection((current) => toggleAgentBlockSelection(current.selectedIds, block.id))
    }, [blocks, rangeEstablished, selecting, selectionAnchorId])
    const enterSelection = React.useCallback((block: AgentMarkdownBlock, event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      setSelection({ selectedIds: new Set([block.id]), selecting: true })
      setSelectionAnchorId(block.id)
      setRangeEstablished(false)
    }, [])
    const exitSelectionFromButton = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      exitSelection()
    }, [exitSelection])
    const hoverBlock = React.useCallback((block: AgentMarkdownBlock) => {
      clearHoverSwitchTimer()
      clearToolbarLeaveTimer()
      const currentId = hoveredBlockId
      if (!selecting && currentId !== null && currentId !== block.id) setToolbarExpanded(false)
      if (selecting && selectedIds.has(block.id) && currentId !== null) {
        const currentAnchor = findAgentSelectionToolbarAnchor(blocks, selectedIds, currentId, true)
        const nextAnchor = findAgentSelectionToolbarAnchor(blocks, selectedIds, block.id, true)
        if (currentAnchor === nextAnchor && currentId !== block.id) {
          hoverSwitchTimerRef.current = setTimeout(() => {
            hoverSwitchTimerRef.current = null
            setHoveredBlockId(block.id)
          }, 180)
          return
        }
      }
      setHoveredBlockId(block.id)
    }, [blocks, clearHoverSwitchTimer, clearToolbarLeaveTimer, hoveredBlockId, selectedIds, selecting])
    const enterToolbar = React.useCallback(() => {
      clearHoverSwitchTimer()
      clearToolbarLeaveTimer()
      setToolbarExpanded(true)
    }, [clearHoverSwitchTimer, clearToolbarLeaveTimer])
    const scheduleHoverLeave = React.useCallback(() => {
      clearToolbarLeaveTimer()
      toolbarLeaveTimerRef.current = setTimeout(() => {
        toolbarLeaveTimerRef.current = null
        setHoveredBlockId(null)
        setToolbarExpanded(false)
      }, 160)
    }, [clearToolbarLeaveTimer])
    const leaveToolbar = React.useCallback(() => {
      scheduleHoverLeave()
    }, [scheduleHoverLeave])

    const hoveredIndex = blocks.findIndex((block) => block.id === hoveredBlockId)
    const hoveredBlock = hoveredIndex >= 0 ? blocks[hoveredIndex]! : null
    const selectedBlocks = blocks.filter((block) => selectedIds.has(block.id))
    const hasSelectedMarkdown = selectedBlocks.some((block) => block.kind === 'markdown')
    const hasSelectedTable = selectedBlocks.some((block) => block.kind === 'table')
    const selectionFormatMode: 'markdown' | 'plainText' | 'tsv' | 'mixed' = !selecting
      ? (hoveredBlock?.kind === 'table' ? 'markdown' : 'plainText')
      : hasSelectedMarkdown && hasSelectedTable
        ? 'mixed'
        : hasSelectedTable
          ? 'tsv'
          : 'markdown'
    const toolbarAnchorIndex = findAgentSelectionToolbarAnchor(blocks, selectedIds, hoveredBlockId, selecting)

    if (!enableBlockCopy) {
      const plugins = [...(remarkPlugins ? [...REMARK_PLUGINS, ...remarkPlugins] : [...REMARK_PLUGINS]), remarkTableSource(processed)]
      return <div className={containerClassName}><Markdown remarkPlugins={plugins} rehypePlugins={REHYPE_PLUGINS} urlTransform={mentionUrlTransform} components={components}>{processed}</Markdown></div>
    }

    return (
      <>
        <div className={cn(containerClassName, selecting && 'select-none')} onPointerLeave={() => { clearHoverSwitchTimer(); scheduleHoverLeave() }}>
          {blocks.map((block, index) => {
            const plugins = [...(remarkPlugins ? [...REMARK_PLUGINS, ...remarkPlugins] : [...REMARK_PLUGINS]), remarkTableSource(block.source)]
            const toolbarBlock = selecting && !selectedIds.has(block.id)
              ? null
              : index === toolbarAnchorIndex ? hoveredBlock : null
            const toolbarTarget = toolbarBlock ?? block
            const previousBlock = blocks[index - 1]
            const nextBlock = blocks[index + 1]
            const margin = agentBlockMargin(block, previousBlock, nextBlock)
            const nextMargin = nextBlock ? agentBlockMargin(nextBlock, block, blocks[index + 2]) : margin
            const bridgeClassName = margin.bottomRank >= nextMargin.topRank ? margin.bottomBridgeClassName : nextMargin.topBridgeClassName
            return <CopyableMarkdownBlock key={block.id} block={block} components={components} remarkPlugins={plugins} selected={selectedIds.has(block.id)} selectedBefore={selectedIds.has(previousBlock?.id ?? '')} selectedAfter={selectedIds.has(nextBlock?.id ?? '')} selecting={selecting} toolbarVisible={toolbarBlock !== null} toolbarBlock={toolbarBlock} toolbarBlockSelected={selectedIds.has(toolbarTarget.id)} copied={copied} toolbarExpanded={toolbarExpanded} previewVisible={!selecting && toolbarExpanded && toolbarBlock?.id === block.id} marginClassName={margin.className} selectionBridgeAfterClassName={bridgeClassName} markdownFormat={markdownFormat} selectionFormatMode={selectionFormatMode} onSelect={(event) => toggleBlock(block, event)} onHover={() => hoverBlock(block)} onToolbarEnter={enterToolbar} onToolbarLeave={leaveToolbar} onCopy={() => void (selecting ? copySelected() : copyBlock(toolbarTarget))} onEnterSelection={(event) => enterSelection(toolbarTarget, event)} onExitSelection={exitSelectionFromButton} onMarkdownFormatChange={setMarkdownFormat} tableFormat={tableFormatFor(toolbarTarget)} onTableFormatChange={(format) => updateTableFormat(toolbarTarget.id, format)} />
          })}
        </div>
      </>
    )
  },
  (prevProps, nextProps) => prevProps.children === nextProps.children && prevProps.basePath === nextProps.basePath && prevProps.basePaths === nextProps.basePaths && prevProps.remarkPlugins === nextProps.remarkPlugins && prevProps.streaming === nextProps.streaming && prevProps.enableBlockCopy === nextProps.enableBlockCopy
)

// ===== UserMessageContent 可折叠用户消息 =====

/** 折叠行数阈值 */
const COLLAPSE_LINE_THRESHOLD = 4

/** 用户消息专用 remark 插件（mention chip + 保留换行） */
const USER_REMARK_PLUGINS: RemarkPluginFn[] = [remarkMentions, remarkPreserveBreaks]

interface UserMessageContentProps extends HTMLAttributes<HTMLDivElement> {
  children: string
  /** 当前 Agent 会话工作目录，用于识别用户消息中的相对文件路径。 */
  basePath?: string
  /** 附加目录候选，用于识别用户消息中的相对文件路径。 */
  basePaths?: string[]
}

/**
 * 用户消息内容组件
 * - 超过 4 行时默认折叠
 * - 点击展开/收起，带渐变遮罩
 */
export const UserMessageContent = React.memo(
  function UserMessageContent({ children, className, basePath, basePaths, ...props }: UserMessageContentProps): React.ReactElement {
    const [isExpanded, setIsExpanded] = React.useState(false)
    const [shouldCollapse, setShouldCollapse] = React.useState(false)
    const contentRef = React.useRef<HTMLDivElement>(null)

    // 检测内容是否超过阈值行数
    React.useEffect(() => {
      if (!contentRef.current) return

      const element = contentRef.current
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight)
      const maxHeight = lineHeight * COLLAPSE_LINE_THRESHOLD

      // scrollHeight 超过最大高度 + 容差时折叠
      setShouldCollapse(element.scrollHeight > maxHeight + 10)
    }, [children])

    const toggleExpand = React.useCallback(() => {
      setIsExpanded((prev) => !prev)
    }, [])

    return (
      <div className={cn('relative inline-block max-w-full rounded-[10px] bg-primary/10 px-3.5 py-2.5', shouldCollapse && !isExpanded && 'pb-6', className)} {...props}>
        <div
          ref={contentRef}
          className={cn(
            'overflow-hidden transition-[max-height] duration-200',
            '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
            shouldCollapse && !isExpanded && 'max-h-[6.5em]'
          )}
        >
          <MessageResponse basePath={basePath} basePaths={basePaths} className="prose-p:my-0.5 prose-headings:my-1.5" remarkPlugins={USER_REMARK_PLUGINS}>{children}</MessageResponse>
        </div>
        {shouldCollapse && (
          <button
            type="button"
            onClick={toggleExpand}
            className={cn(
              'flex items-center gap-1 text-xs text-foreground/40 hover:text-foreground/70 transition-colors mt-1',
              !isExpanded &&
                'absolute bottom-0 left-0 right-0 px-3.5 pb-2.5 pt-4 rounded-b-[10px] bg-gradient-to-t from-primary/10 to-transparent'
            )}
          >
            {isExpanded ? (
              <>
                <ChevronUp className="size-3" />
                <span>收起</span>
              </>
            ) : (
              <>
                <ChevronDown className="size-3" />
                <span>展开全部</span>
              </>
            )}
          </button>
        )}
      </div>
    )
  },
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    prevProps.basePath === nextProps.basePath &&
    prevProps.basePaths === nextProps.basePaths
)

// ===== MessageLoading 加载动画 =====

type MessageLoadingProps = HTMLAttributes<HTMLDivElement> & { startedAt?: number }

/** 等待首个 chunk 的加载动画 */
export function MessageLoading({ className, startedAt, ...props }: MessageLoadingProps): React.ReactElement {
  return (
    <div className={cn('mt-0', className)} {...props}>
      <LoadingIndicator
        label="正在思考..."
        size="sm"
        showElapsed={startedAt || true}
        className="text-muted-foreground/60"
      />
    </div>
  )
}

// ===== MessageStopped 已停止生成 =====

type MessageStoppedProps = HTMLAttributes<HTMLDivElement>

/** "已停止生成" 状态标记 */
export function MessageStopped({ className, ...props }: MessageStoppedProps): React.ReactElement {
  return (
    <div
      className={cn('flex items-center gap-1.5 text-sm text-muted-foreground mt-2', className)}
      {...props}
    >
      <span className="size-2 rounded-full bg-muted-foreground/40" />
      <span>已停止生成</span>
    </div>
  )
}

// ===== MessageAttachments 消息附件展示 =====

interface MessageAttachmentsProps extends HTMLAttributes<HTMLDivElement> {
  /** 附件列表 */
  attachments: FileAttachment[]
}

/** 消息附件容器 */
export function MessageAttachments({
  attachments,
  className,
  ...props
}: MessageAttachmentsProps): React.ReactElement {
  const imageAttachments = attachments.filter((att) => att.mediaType.startsWith('image/'))
  const fileAttachments = attachments.filter((att) => !att.mediaType.startsWith('image/'))
  const isSingleImage = imageAttachments.length === 1 && fileAttachments.length === 0

  return (
    <div className={cn('flex flex-col gap-2 mb-2', className)} {...props}>
      {/* 图片附件 */}
      {imageAttachments.length > 0 && (
        <div className="flex flex-wrap gap-2.5">
          {imageAttachments.map((att) => (
            <MessageAttachmentImage key={att.id} attachment={att} isSingle={isSingleImage} />
          ))}
        </div>
      )}
      {/* 文件附件 */}
      {fileAttachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {fileAttachments.map((att) => (
            <MessageAttachmentFile key={att.id} attachment={att} />
          ))}
        </div>
      )}
    </div>
  )
}

// ===== MessageAttachmentImage 图片附件展示 =====

interface MessageAttachmentImageProps {
  attachment: FileAttachment
  /** 是否为唯一附件（单图模式） */
  isSingle?: boolean
}

/** 图片附件展示（单图: max 500px，多图: 280px 方块），点击可预览大图 */
function MessageAttachmentImage({ attachment, isSingle = false }: MessageAttachmentImageProps): React.ReactElement {
  const [imageSrc, setImageSrc] = React.useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = React.useState(false)

  React.useEffect(() => {
    window.electronAPI
      .readAttachment(attachment.localPath)
      .then((base64) => {
        setImageSrc(`data:${attachment.mediaType};base64,${base64}`)
      })
      .catch((error) => {
        console.error('[MessageAttachmentImage] 读取附件失败:', error)
      })
  }, [attachment.localPath, attachment.mediaType])

  /** 保存图片到本地 */
  const handleSave = React.useCallback((): void => {
    window.electronAPI.saveImageAs(attachment.localPath, attachment.filename)
  }, [attachment.localPath, attachment.filename])

  if (!imageSrc) {
    return (
      <div className={cn(
        'rounded-lg bg-muted/30 animate-pulse shrink-0',
        isSingle ? 'w-[280px] h-[200px]' : 'size-[280px]'
      )} />
    )
  }

  const imgElement = isSingle ? (
    <img
      src={imageSrc}
      alt={attachment.filename}
      className="max-w-[500px] max-h-[min(500px,50vh)] rounded-lg object-contain cursor-pointer"
      onClick={() => setLightboxOpen(true)}
    />
  ) : (
    <img
      src={imageSrc}
      alt={attachment.filename}
      className="size-[280px] rounded-lg object-cover shrink-0 cursor-pointer"
      onClick={() => setLightboxOpen(true)}
    />
  )

  return (
    <div className="relative group inline-block">
      {imgElement}
      <button
        type="button"
        onClick={handleSave}
        className="absolute bottom-2 right-2 p-1.5 rounded-md bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/70"
        title="保存图片"
      >
        <Download className="size-4" />
      </button>
      <ImageLightbox
        src={imageSrc}
        alt={attachment.filename}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        onSave={handleSave}
      />
    </div>
  )
}

// ===== MessageAttachmentFile 文件附件展示 =====

interface MessageAttachmentFileProps {
  attachment: FileAttachment
}

/** 文件附件展示（标签样式，teal 色调） */
function MessageAttachmentFile({ attachment }: MessageAttachmentFileProps): React.ReactElement {
  /** 截断文件名 */
  const displayName = attachment.filename.length > 20
    ? attachment.filename.slice(0, 17) + '...'
    : attachment.filename

  return (
    <div className="flex items-center gap-2 rounded-lg bg-[#37a5aa]/10 border border-[#37a5aa]/20 px-3 py-1.5 text-[13px] text-[#37a5aa] shrink-0">
      <Paperclip className="size-4" />
      <span>{displayName}</span>
    </div>
  )
}

// ===== StreamingIndicator 流式呼吸脉冲点 =====

type StreamingIndicatorProps = HTMLAttributes<HTMLSpanElement>

/** 流式生成中的呼吸脉冲点指示器 */
export function StreamingIndicator({ className, ...props }: StreamingIndicatorProps): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-block size-2 rounded-full bg-primary/60 animate-pulse ml-1 align-middle',
        className
      )}
      {...props}
    />
  )
}
