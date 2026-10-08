import { createDebouncedCallback } from '@/lib/debounce'
import type { SystemPromptUpdateInput } from '@profer/shared'

/**
 * 提示词自动保存的“待写队列”（框架无关，便于行为测试）。
 *
 * 语义：
 * - 输入期间防抖 `waitMs`，只落盘一次（“只取最终结果”，debounce 是正确工具）；
 * - 可选 `maxWaitMs`：连续输入不停时也保证至少每 `maxWaitMs` 落盘一次（避免旧值无限期住在内存里）；
 * - 同一提示词的多次字段变更**合并**提交：同字段取最新、不同字段累加；
 * - 不同提示词各占一条，切换时互不覆盖；
 * - `flush()` 立即提交全部待写条目（组件卸载、切换对象前调用）。
 *
 * 反面教材（本模块修复的两个真实缺陷）：
 * 1. 旧实现每次调用都重置防抖且只携带本次字段，于是“先改名、再改内容”会把改名丢掉；
 * 2. 旧实现没有 flush，组件卸载时最后一段输入直接丢失。
 */

/** 合并某条提示词的待写字段：同字段取最新值，不同字段累加。 */
export function mergeSystemPromptUpdate(
  pending: Map<string, SystemPromptUpdateInput>,
  id: string,
  input: SystemPromptUpdateInput
): void {
  const previous = pending.get(id)
  pending.set(id, previous ? { ...previous, ...input } : input)
}

export interface PromptSaveQueueOptions {
  /** 最长延迟（ms）：连续输入不停时也保证至少每该时长落盘一次 */
  maxWaitMs?: number
  onError?: (error: unknown) => void
}

export interface PromptSaveQueue {
  /** 记录一次字段变更；真正的写入在静默 `waitMs` 后触发。 */
  queue(id: string, input: SystemPromptUpdateInput): void
  /** 立即提交全部待写条目，并取消等待中的定时器。 */
  flush(): Promise<void>
  /** 尚未提交的提示词条数。 */
  pendingCount(): number
}

export function createPromptSaveQueue(
  save: (id: string, input: SystemPromptUpdateInput) => Promise<void>,
  waitMs: number,
  options: PromptSaveQueueOptions = {}
): PromptSaveQueue {
  const pending = new Map<string, SystemPromptUpdateInput>()

  let inFlight: Promise<void> | null = null
  const drain = (): Promise<void> => {
    if (inFlight) return inFlight
    const run = async (): Promise<void> => {
      const failed = new Set<string>()
      let firstError: unknown
      while ([...pending.keys()].some((id) => !failed.has(id))) {
        const ids = [...pending.keys()].filter((id) => !failed.has(id))
        for (const id of ids) {
          const input = pending.get(id)
          if (!input) continue
          pending.delete(id)
          try {
            await save(id, input)
          } catch (error) {
            if (firstError === undefined) firstError = error
            failed.add(id)
            const newer = pending.get(id)
            pending.set(id, { ...input, ...newer })
          }
        }
      }
      if (failed.size) throw firstError
    }
    inFlight = run().finally(() => { inFlight = null })
    return inFlight
  }

  const debounced = createDebouncedCallback(
    () => {
      void drain().catch((error: unknown) => options.onError?.(error))
    },
    waitMs,
    { maxWait: options.maxWaitMs }
  )

  return {
    queue(id: string, input: SystemPromptUpdateInput): void {
      mergeSystemPromptUpdate(pending, id, input)
      debounced()
    },
    flush(): Promise<void> {
      debounced.cancel()
      return drain()
    },
    pendingCount(): number {
      return pending.size
    },
  }
}
