/**
 * usePaperReading — 论文精读
 *
 * 拖入 PDF → 正常附件；点按钮 → 取附件中 PDF 的真实路径 → 估页（>50 页弹确认框）
 * → MinerU 解析 → .md 附件 + prompt。不弹文件对话框。
 */

import * as React from 'react'
import { toast } from 'sonner'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsePaperReadingOptions {
  isStreaming: boolean
  onParsed: (markdown: string, pages: number, creditsUsed: number, pdfName?: string) => Promise<void>
}

export interface LargePaperConfirm {
  filePath: string
  fileName?: string
  pages: number
  estimatedCredits: number
}

export interface UsePaperReadingReturn {
  isMineruLoading: boolean
  /** >50 页时为非 null，需渲染 ConfirmDialog */
  largePaperConfirm: LargePaperConfirm | null
  parseByPath: (filePath: string, fileName?: string) => void
  confirmLargePaper: () => void
  cancelLargePaper: () => void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LARGE_PAPER_THRESHOLD = 50

export const PAPER_PROMPT =
  '请用通俗易懂的语言解读这篇论文，包括：\n' +
  '1. 论文要解决什么问题\n' +
  '2. 用了什么方法\n' +
  '3. 主要结论是什么\n' +
  '4. 有什么局限'

export function markdownToFile(markdown: string, pdfName?: string): File {
  const mdName = pdfName ? pdfName.replace(/\.pdf$/i, '.md') : '论文解析.md'
  return new File([markdown], mdName, { type: 'text/markdown' })
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePaperReading({
  isStreaming,
  onParsed,
}: UsePaperReadingOptions): UsePaperReadingReturn {
  const [isMineruLoading, setIsMineruLoading] = React.useState(false)
  const [largePaperConfirm, setLargePaperConfirm] = React.useState<LargePaperConfirm | null>(null)

  /** 实际执行 MinerU 解析 */
  const doParse = React.useCallback(
    async (filePath: string, fileName?: string) => {
      setIsMineruLoading(true)
      try {
        const result = await window.electronAPI.parsePaperByPath(filePath)
        if (!result) return
        await onParsed(result.markdown, result.pages, result.creditsUsed, fileName)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : '未知错误'
        console.error('[论文精读] 失败:', msg)
        toast.error('论文解析失败: ' + msg)
      } finally {
        setIsMineruLoading(false)
      }
    },
    [onParsed],
  )

  const parseByPath = React.useCallback(
    async (filePath: string, fileName?: string) => {
      if (isStreaming || isMineruLoading) return

      try {
        // Step 1: 本地估算页数
        const estimate = await window.electronAPI.estimatePaperPages(filePath)

        // Step 2: 大于 50 页 → 设置确认状态，由调用方渲染 ConfirmDialog
        if (estimate.pages > LARGE_PAPER_THRESHOLD) {
          setLargePaperConfirm({
            filePath,
            fileName,
            pages: estimate.pages,
            estimatedCredits: estimate.estimatedCredits,
          })
          return
        }

        // Step 3: 直接解析
        await doParse(filePath, fileName)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : '未知错误'
        console.error('[论文精读] 估算页数失败:', msg)
        toast.error('论文解析失败: ' + msg)
      }
    },
    [isStreaming, isMineruLoading, doParse],
  )

  /** 用户确认解析大论文 */
  const confirmLargePaper = React.useCallback(() => {
    if (!largePaperConfirm) return
    const { filePath, fileName } = largePaperConfirm
    setLargePaperConfirm(null)
    doParse(filePath, fileName)
  }, [largePaperConfirm, doParse])

  /** 用户取消解析大论文 */
  const cancelLargePaper = React.useCallback(() => {
    setLargePaperConfirm(null)
  }, [])

  return { isMineruLoading, largePaperConfirm, parseByPath, confirmLargePaper, cancelLargePaper }
}
