import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * 纯文本检测：判断文本中是否包含 markdown 结构（标题/列表/引用/代码/加粗/链接/表格/HTML/Latex 分隔符）。
 * 含 markdown 结构的流式内容不能逐字符拆分（会破坏解析与代码高亮），应保持整块 markdown 渲染。
 * 普通问答（占比最高的场景）为纯文本，可安全使用逐字符渐入动效。
 */
const MARKDOWN_STRUCT_RE = /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|~~~)|`|(\*\*|__)|\[[^\]]*\]\(|^\s*\||<\/?[a-z]|\$\$/m

export function isPlainStreamText(text: string): boolean {
  if (!text) return true
  return !MARKDOWN_STRUCT_RE.test(text)
}

/** 多语言字符分割器（正确处理中文、日文等多字节字符） */
const segmenter = new Intl.Segmenter([
  'en-US', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR', 'de-DE', 'fr-FR', 'es-ES', 'pt-PT', 'ru-RU',
])

function segmentText(text: string): string[] {
  return Array.from(segmenter.segment(text)).map((s) => s.segment)
}

const StreamChar = React.memo(function StreamChar({ char }: { char: string }): React.ReactElement {
  if (char === '\n') return <br />
  return <span className="stream-char">{char}</span>
})

interface StreamingTextProps {
  text: string
  /** 尾部逐字符动画窗口大小（字符数）。窗口之前的字符合并为纯文本节点，控制 DOM span 数量上限。 */
  tailWindow?: number
}

/**
 * 流式文本打字机动效：
 * - 尾部 tailWindow 个字符逐字渲染（每个字符淡入 + 轻微上浮）
 * - 更早的字符合并为单个纯文本节点（pre-wrap 保留换行），性能有界
 * - 适用于纯文本内容（无 markdown 结构），见 isPlainStreamText
 */
export function StreamingText({ text, tailWindow = 400 }: StreamingTextProps): React.ReactElement {
  const { head, tail, tailStart } = React.useMemo(() => {
    const len = text.length
    if (len <= tailWindow) return { head: '', tail: text, tailStart: 0 }
    return {
      head: text.slice(0, len - tailWindow),
      tail: text.slice(len - tailWindow),
      tailStart: len - tailWindow,
    }
  }, [text, tailWindow])

  const tailChars = React.useMemo(() => segmentText(tail), [tail])

  return (
    <span className="streaming-text">
      {head && <span className="streaming-head">{head}</span>}
      {tailChars.map((char, i) => (
        <StreamChar key={tailStart + i} char={char} />
      ))}
    </span>
  )
}

/** 流式输出末尾的闪烁打字光标（颜色跟随 currentColor，自动适配深浅主题） */
export function StreamingCursor({ className }: { className?: string }): React.ReactElement {
  return <span className={cn('streaming-cursor', className)} aria-hidden="true" />
}
