/**
 * CopyButton - 复制消息内容按钮
 *
 * 使用 MessageAction + Copy/Check 图标切换。
 * 移植自 profer-frontend 的 chat-view/copy-button.tsx。
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { CopyIcon, CheckIcon } from 'lucide-react'
import { MessageAction } from '@/components/ai-elements/message'

interface CopyButtonProps {
  /** 要复制的内容 */
  content: string
  /** 将 Markdown 转义还原为用户可见的纯文本后再复制。 */
  copyAsPlainText?: boolean
}

/**
 * 编辑器为保证 Markdown 渲染会转义反斜杠，例如 Windows 路径中的 `\\` 会存为
 * `\\\\`。消息复制应取得用户看到的纯文本，而不是这份内部 Markdown 源码，
 * 否则反复复制、粘贴会使反斜杠不断翻倍。
 */
export function unescapeMarkdownTextForClipboard(content: string): string {
  return content
    // 两个相邻反斜杠是编辑器为原始路径反斜杠写入的 Markdown 转义。
    .replace(/\\\\/g, '\\')
    // 其余 Markdown 字符的转义同样应按用户看到的纯文本复制。
    .replace(/\\\\([`*_[\]<>|#>+\-.])/g, '$1')
}

export function CopyButton({ content, copyAsPlainText = false }: CopyButtonProps): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(copyAsPlainText ? unescapeMarkdownTextForClipboard(content) : content)
      setCopied(true)
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('复制失败:', error)
    }
  }, [content, copyAsPlainText])

  useEffect(() => {
    return () => clearTimeout(timerRef.current)
  }, [])

  return (
    <MessageAction
      tooltip={copied ? '已复制' : '复制'}
      onClick={handleCopy}
    >
      {copied ? (
        <CheckIcon className="size-4" />
      ) : (
        <CopyIcon className="size-4" />
      )}
    </MessageAction>
  )
}
