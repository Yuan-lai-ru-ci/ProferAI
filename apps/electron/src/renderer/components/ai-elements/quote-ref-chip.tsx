import * as React from 'react'
import { createPortal } from 'react-dom'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { describeQuoteChipDetail, describeQuoteChipLabel } from '@/lib/quoted-selection'
import { cn } from '@/lib/utils'
import { getActiveQuotePreview, markQuotePreviewClosing, resolveQuotePreviewDelay, setActiveQuotePreview } from '@/lib/quote-preview-store'
import type { QuoteRefPayload } from './quote-ref-node'

/**
 * 引用胶囊（TipTap nodeView）。
 *
 * 显示：编号 + 一个来源短词，只承担「指代」，正文里的句子骨架必须还在。
 * 悬停 1000ms 弹出预览：来源细节 + **按 Markdown 渲染好的原文**。
 *
 * 动画要点：卡片必须**先以关闭态挂载、下一帧再切到打开态**，CSS transition 才会真正播放；
 * 直接在首帧渲染成打开态会「啪」地弹出来（上一版就是这么生硬的）。
 */

const PREVIEW_EXIT_MS = 140
const PREVIEW_WIDTH = 380
const PREVIEW_MAX_HEIGHT = 320
const PREVIEW_MARGIN = 12

type Phase = 'closed' | 'opening' | 'open' | 'closing'

interface PreviewAnchor {
  /** above = 贴在胶囊上方（输入框在底部时的默认），below = 下方 */
  placement: 'above' | 'below'
  /** 左对齐时的 left；右对齐时为 null（用 right 定位） */
  left: number | null
  /** 右对齐时的 right（距视口右缘）；左对齐时为 null */
  right: number | null
  /** 卡片最大宽度：内容短就窄，不硬撑 380 */
  maxWidth: number
  /** above 用 bottom 定位，below 用 top 定位 */
  offset: number
  maxHeight: number
}

export function QuoteRefChipView({ node, deleteNode, editor }: NodeViewProps): React.ReactElement {
  const payload = node.attrs.quote as QuoteRefPayload | null
  const n = Number(node.attrs.n) || 1
  const label = payload ? describeQuoteChipLabel(payload) : ''
  const detail = payload ? describeQuoteChipDetail(payload) : ''
  const [preview, setPreview] = React.useState<PreviewAnchor | null>(null)
  const [phase, setPhase] = React.useState<Phase>('closed')
  const timerRef = React.useRef<number | null>(null)
  const exitTimerRef = React.useRef<number | null>(null)
  const frameRef = React.useRef<number | null>(null)
  // 每个胶囊实例一个稳定 id：全局单例据此裁决「同一时刻只显示一个预览」
  const instanceIdRef = React.useRef<string>(`quote-preview-${Math.random().toString(36).slice(2)}`)
  const instanceId = instanceIdRef.current

  const clearOpenTimer = React.useCallback((): void => {
    if (timerRef.current === null) return
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  /** 收起：先播退场，再卸载；只有占位是自己时才释放，避免误关别人的预览。 */
  const beginClose = React.useCallback((): void => {
    // 一开始收就记时间：用户常在退场动画期间就移到下一条胶囊
    markQuotePreviewClosing()
    setPhase((current) => (current === 'closed' || current === 'closing' ? current : 'closing'))
    if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current)
    exitTimerRef.current = window.setTimeout(() => {
      exitTimerRef.current = null
      setPreview(null)
      setPhase('closed')
      if (getActiveQuotePreview() === instanceId) setActiveQuotePreview(null)
    }, PREVIEW_EXIT_MS)
  }, [instanceId])

  React.useEffect(() => () => {
    clearOpenTimer()
    if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current)
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    if (getActiveQuotePreview() === instanceId) setActiveQuotePreview(null)
  }, [clearOpenTimer, instanceId])

  // 浮层：滚动/缩放/ESC 收起，避免卡片脱离胶囊
  React.useEffect(() => {
    if (!preview) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') beginClose()
    }
    window.addEventListener('scroll', beginClose, true)
    window.addEventListener('resize', beginClose)
    window.addEventListener('blur', beginClose)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('scroll', beginClose, true)
      window.removeEventListener('resize', beginClose)
      window.removeEventListener('blur', beginClose)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [beginClose, preview])

  const schedulePreview = (element: HTMLElement): void => {
    if (!payload) return
    clearOpenTimer()
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      const rect = element.getBoundingClientRect()
      // 宽度交给内容（max-content），只在贴近视口边缘时收窄；右半屏改为右缘对齐，
      // 避免「几个字也撑出 380px 大白框」和右溢被硬夹到左边。
      const alignRight = rect.left > window.innerWidth / 2
      const available = alignRight
        ? rect.right - PREVIEW_MARGIN
        : window.innerWidth - rect.left - PREVIEW_MARGIN
      const maxWidth = Math.max(160, Math.min(PREVIEW_WIDTH, available))
      const left = alignRight ? null : Math.max(PREVIEW_MARGIN, rect.left)
      const right = alignRight ? Math.max(PREVIEW_MARGIN, window.innerWidth - rect.right) : null
      // 输入框在窗口底部，所以默认贴胶囊**上方**；上方放不下才翻到下方
      const spaceAbove = rect.top - PREVIEW_MARGIN
      const spaceBelow = window.innerHeight - rect.bottom - PREVIEW_MARGIN
      const placeAbove = spaceAbove >= 180 || spaceAbove >= spaceBelow
      const maxHeight = Math.max(120, Math.min(PREVIEW_MAX_HEIGHT, (placeAbove ? spaceAbove : spaceBelow) - 8))

      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current)
        exitTimerRef.current = null
      }
      setPreview({
        placement: placeAbove ? 'above' : 'below',
        left,
        right,
        maxWidth,
        offset: placeAbove ? window.innerHeight - rect.top + 8 : rect.bottom + 8,
        maxHeight,
      })
      setPhase('opening')
      // 预览是纯浮层，不该影响编辑器焦点；若挂载/重渲染把焦点弄丢了，这里恢复回来。
      const hadEditorFocus = editor?.isFocused ?? false
      // 两帧后再切打开态：首帧以关闭态完成布局，transition 才有起点
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null
          setPhase((current) => (current === 'opening' ? 'open' : current))
          if (hadEditorFocus && editor && !editor.isDestroyed && !editor.isFocused) {
            editor.commands.focus(undefined, { scrollIntoView: false })
          }
        })
      })
      // 注册「被顶掉时怎么收」：由打开者直接调用上一个的 beginClose，无需全局订阅
      setActiveQuotePreview(instanceId, beginClose)
    }, resolveQuotePreviewDelay())
  }

  const visible = Boolean(preview && payload)

  return (
    <>
      <NodeViewWrapper
        as="span"
        className="quote-ref-chip"
        data-quote-ref=""
        data-quote-n={n}
        aria-label={payload ? `引用 ${n}：${detail}，悬停 1 秒查看原文` : '引用来源已失效'}
        contentEditable={false}
        onMouseEnter={(event: React.MouseEvent<HTMLElement>) => schedulePreview(event.currentTarget)}
        onMouseLeave={() => {
          // 离开胶囊（包括划出输入框）就收起：只清计时会让已弹出的预览一直挂着
          clearOpenTimer()
          if (phase === 'open' || phase === 'opening') beginClose()
        }}
      >
        <span className="quote-ref-chip__n">{n}</span>
        {label ? <span className="quote-ref-chip__sep" aria-hidden="true" /> : null}
        {label ? <span className="quote-ref-chip__label">{label}</span> : null}
        {/* 悬停才出现的移除按钮：绝对定位，不占位，避免胶囊宽度跳动 */}
        <button
          type="button"
          className="quote-ref-chip__remove"
          aria-label="移除这条引用"
          tabIndex={-1}
          onMouseDown={(event) => {
            // 不要抢编辑器焦点，也不要把光标塞进胶囊
            event.preventDefault()
            event.stopPropagation()
          }}
          onMouseEnter={() => {
            // 指向 × 时既不要再开预览，已开的也顺手收起
            clearOpenTimer()
            if (phase === 'open' || phase === 'opening') beginClose()
          }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            clearOpenTimer()
            setActiveQuotePreview(null)
            deleteNode()
          }}
        >
          ×
        </button>
      </NodeViewWrapper>

      {visible && preview && payload
        ? createPortal(
            <div
              className={cn(
                'quote-ref-preview',
                preview.placement === 'above' ? 'quote-ref-preview--above' : 'quote-ref-preview--below',
                phase === 'open' ? 'is-open' : phase === 'closing' ? 'is-closing' : null,
              )}
              style={{
                maxWidth: preview.maxWidth,
                maxHeight: preview.maxHeight,
                ...(preview.left !== null ? { left: preview.left } : { right: preview.right ?? PREVIEW_MARGIN }),
                ...(preview.placement === 'above' ? { bottom: preview.offset } : { top: preview.offset }),
              }}
              role="tooltip"
            >
              <div className="quote-ref-preview__head">
                <span className="quote-ref-preview__n">{n}</span>
                <span className="quote-ref-preview__source">{detail}</span>
              </div>
              <div className="quote-ref-preview__body prose prose-sm dark:prose-invert max-w-none">
                <Markdown remarkPlugins={[remarkGfm]}>{payload.text}</Markdown>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
