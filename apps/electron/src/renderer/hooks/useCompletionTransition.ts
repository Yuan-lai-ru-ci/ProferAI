import { useEffect, useState } from 'react'

/**
 * 流式收尾到持久化替换完成期间使用 instant resize。
 * pending 只表示等待持久化；150ms 是替换完成后的有限布局兜底。
 */
export function useCompletionTransition(streaming: boolean, pending: boolean): boolean {
  const [phase, setPhase] = useState({ streaming, cooldown: false })

  // 在本组件的 render 阶段同步轮次，结束首帧就能使用 instant。
  // 新轮次同时清空上一轮 cooldown，避免旧状态延续到后续输出。
  if (phase.streaming !== streaming) {
    setPhase({ streaming, cooldown: !streaming })
  }

  useEffect(() => {
    if (streaming || pending || !phase.cooldown) return

    const timer = setTimeout(() => {
      setPhase((current) => ({ ...current, cooldown: false }))
    }, 150)
    return () => clearTimeout(timer)
  }, [streaming, pending, phase.cooldown])

  return !streaming && (
    pending
    || phase.cooldown
    || phase.streaming
  )
}
