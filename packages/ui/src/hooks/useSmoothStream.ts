/**
 * useSmoothStream - 流式文本平滑渲染 Hook
 *
 * 将后端推送的流式文本（可能每秒几十次更新）转化为
 * 平滑的逐字渲染效果，类似打字机。
 *
 * 核心设计目标：**稳定、有序的输出节奏**
 * - 无论 chunk 到达节奏如何，用户看到的都是均匀的文字流
 * - 基础速率恒定（2字符/帧），积压时平缓加速追赶，不会突变
 * - 双缓冲机制：rAF 持续积累字符，React setState 按节拍刷新，
 *   避免高频 Markdown 重解析导致的帧率下降
 *
 * 核心机制：
 * 1. 新增 delta 通过 Intl.Segmenter 拆分为字符粒度后入队
 * 2. requestAnimationFrame 驱动渲染循环，持续将字符从队列移入缓冲区
 * 3. 每帧恒定基础速率 + 积压平缓追赶（线性加速，无突变）
 * 4. React setState 按 renderInterval 节拍触发（默认 ~30fps），
 *    将缓冲区内容一次性刷新到 UI，减少 Markdown 重解析频率
 * 5. 流结束时一次性输出剩余内容
 */

import { useCallback, useEffect, useRef, useState } from 'react'

interface UseSmoothStreamOptions {
  /** 原始流式内容（每次 chunk 累积后的完整文本） */
  content: string
  /** 是否正在流式输出中 */
  isStreaming: boolean
  /**
   * React setState 触发间隔（ms），控制 Markdown 重解析频率。
   * 默认 36（约 28fps），在视觉流畅与渲染性能之间取得平衡。
   * rAF 循环仍然每帧运行（~16ms），字符在缓冲区中持续积累。
   */
  renderInterval?: number
}

interface UseSmoothStreamReturn {
  /** 平滑后的显示内容 */
  displayedContent: string
}

// ===== 速率常量 =====

/** 基础每帧输出字符数（保持稳定节奏） */
const BASE_RATE = 2
/** 队列积压超过此值时开始平缓加速追赶 */
const CATCHUP_THRESHOLD = 40
/** 追赶加速因子（越大越平缓，8 = 每积压 8 字符加速 1 字符/帧） */
const CATCHUP_DIVISOR = 8

/** 多语言字符分割器（正确处理中文、日文等多字节字符） */
const segmenter = new Intl.Segmenter(
  ['en-US', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR', 'de-DE', 'fr-FR', 'es-ES', 'pt-PT', 'ru-RU'],
)

/** 用 Intl.Segmenter 将文本拆分为字符数组 */
function segmentText(text: string): string[] {
  return Array.from(segmenter.segment(text)).map((s) => s.segment)
}

/**
 * 流式文本平滑渲染 Hook
 *
 * @example
 * ```tsx
 * const streamingContent = useAtomValue(streamingContentAtom)
 * const isStreaming = useAtomValue(streamingAtom)
 *
 * const { displayedContent } = useSmoothStream({
 *   content: streamingContent,
 *   isStreaming,
 * })
 *
 * return <MessageResponse>{displayedContent}</MessageResponse>
 * ```
 */
export function useSmoothStream({
  content,
  isStreaming,
  renderInterval = 36,
}: UseSmoothStreamOptions): UseSmoothStreamReturn {
  const [displayedContent, setDisplayedContent] = useState(content)

  // 字符队列（待渲染的字符）
  const chunkQueueRef = useRef<string[]>([])
  // rAF ID
  const rafRef = useRef<number | null>(null)
  // 已提交到 React state 的文本
  const committedRef = useRef(content)
  // rAF 循环中累积的缓冲文本（尚未提交到 state）
  const bufferRef = useRef(content)
  // 上一次收到的完整内容（用于计算 delta）
  const prevContentRef = useRef(content)
  // 上次 React setState 时间
  const lastCommitTimeRef = useRef(0)
  // 流是否结束
  const streamDoneRef = useRef(!isStreaming)

  // 同步 streamDone 状态
  streamDoneRef.current = !isStreaming

  // 检测内容变化，计算 delta 并入队
  useEffect(() => {
    const prevContent = prevContentRef.current
    const newContent = content

    if (newContent === prevContent) return

    // 检测是否为追加（正常流式）
    const isAppend = newContent.startsWith(prevContent)

    if (isAppend) {
      // 增量部分拆分为字符后入队
      const delta = newContent.slice(prevContent.length)
      if (delta) {
        const chars = segmentText(delta)
        chunkQueueRef.current.push(...chars)
      }
    } else {
      // 内容重置（用户重新发送等场景）
      chunkQueueRef.current = []
      bufferRef.current = newContent
      committedRef.current = newContent
      setDisplayedContent(newContent)
    }

    prevContentRef.current = newContent
  }, [content])

  // 非流式状态时，直接显示完整内容（历史消息、编辑后的消息等）
  useEffect(() => {
    if (!isStreaming) {
      // 如果队列还有剩余，一次性输出
      if (chunkQueueRef.current.length > 0) {
        bufferRef.current += chunkQueueRef.current.join('')
        chunkQueueRef.current = []
      }
      // 确保显示内容与实际内容一致
      if (bufferRef.current !== content) {
        bufferRef.current = content
      }
      committedRef.current = bufferRef.current
      setDisplayedContent(committedRef.current)
    }
  }, [isStreaming, content])

  /**
   * 将缓冲区内容提交到 React state（触发 Markdown 重渲染）。
   * 仅在缓冲区有新内容时才调用 setState。
   */
  const commitBuffer = useCallback((time: number) => {
    if (bufferRef.current !== committedRef.current) {
      committedRef.current = bufferRef.current
      setDisplayedContent(committedRef.current)
      lastCommitTimeRef.current = time
    }
  }, [])

  // 渲染循环
  const renderLoop = useCallback((currentTime: number) => {
    const queue = chunkQueueRef.current

    // 队列为空
    if (queue.length === 0) {
      // 提交缓冲区中剩余内容
      commitBuffer(currentTime)

      if (streamDoneRef.current) {
        // 流结束 + 队列空 → 停止循环
        rafRef.current = null
        return
      }
      // 流未结束但队列空 → 等下一帧
      rafRef.current = requestAnimationFrame(renderLoop)
      return
    }

    // ===== 计算本帧输出字符数：稳定基础速率 + 平缓追赶 =====
    let count: number

    if (streamDoneRef.current) {
      // 流结束：一次性输出所有剩余
      count = queue.length
    } else if (queue.length > CATCHUP_THRESHOLD) {
      // 积压较多：基础速率 + 线性追赶（平缓加速，不会突变）
      const extra = Math.ceil((queue.length - CATCHUP_THRESHOLD) / CATCHUP_DIVISOR)
      count = BASE_RATE + extra
    } else {
      // 正常流式：恒定基础速率，保持稳定节奏
      count = Math.min(BASE_RATE, queue.length)
    }

    // 从队列取出字符，追加到缓冲区
    const chars = queue.splice(0, count)
    bufferRef.current += chars.join('')

    // ===== 按节拍提交到 React state =====
    // rAF 每帧（~16ms）移动字符到缓冲区，但 setState 按 renderInterval 节拍触发，
    // 减少 Markdown 重解析频率（从 ~60fps 降到 ~28fps），显著降低 CPU 开销
    if (currentTime - lastCommitTimeRef.current >= renderInterval) {
      commitBuffer(currentTime)
    }

    // 还有内容或流未结束 → 继续下一帧
    if (queue.length > 0 || !streamDoneRef.current) {
      rafRef.current = requestAnimationFrame(renderLoop)
    } else {
      // 队列刚好清空：立即提交剩余缓冲
      commitBuffer(currentTime)
      rafRef.current = null
    }
  }, [renderInterval, commitBuffer])

  // 启动/重启渲染循环
  useEffect(() => {
    if (isStreaming && !rafRef.current) {
      rafRef.current = requestAnimationFrame(renderLoop)
    }

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [isStreaming, renderLoop])

  return { displayedContent }
}
