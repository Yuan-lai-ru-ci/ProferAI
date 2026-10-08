import * as React from 'react'
import { atom, useStore } from 'jotai'
import { toast } from 'sonner'
import { createPromptSaveQueue, type PromptSaveQueue } from '@/lib/prompt-save-queue'
import { promptConfigAtom, selectedPromptIdAtom } from '@/atoms/system-prompt-atoms'
import type { SystemPromptUpdateInput } from '@profer/shared'

/** 提示词自动保存的防抖延迟（ms） */
export const PROMPT_SAVE_DEBOUNCE_MS = 500

/** 最长延迟（ms）：连续输入不停时也至少每 2s 落盘一次，避免编辑长期只停留在内存 */
export const PROMPT_SAVE_MAX_WAIT_MS = 2000

/**
 * 提示词编辑器的自动保存（`PromptSettings` 与 `PromptEditorSidebar` 共用）。
 *
 * 防抖、字段合并与卸载 flush 的语义都在框架无关的 `createPromptSaveQueue` 里并已被
 * 行为测试覆盖（见 `lib/prompt-save-queue.test.ts`）；这里只负责接线：
 * 调用 IPC 落盘、把返回值同步回全局配置、组件卸载时 flush。
 */
export interface SystemPromptAutosave {
  (id: string, input: SystemPromptUpdateInput): void
  flush: () => Promise<void>
  remove: (id: string) => Promise<void>
}

export const promptSaveStateAtom = atom<'saved' | 'pending' | 'saving' | 'error'>('saved')
export const promptDeletingIdsAtom = atom<readonly string[]>([])
const queues = new WeakMap<ReturnType<typeof useStore>, SystemPromptAutosave>()

export function getSystemPromptAutosave(store: ReturnType<typeof useStore>): SystemPromptAutosave {
  const existing = queues.get(store)
  if (existing) return existing
  const revisions = new Map<string, number>()
  const deletions = new Map<string, Promise<void>>()
  const reportFailure = (): void => {
    store.set(promptSaveStateAtom, 'error')
    toast.error('提示词保存失败，草稿已保留，请重试保存')
  }
  let queue: PromptSaveQueue
  queue = createPromptSaveQueue(async (id, input) => {
    const revision = revisions.get(id)
    store.set(promptSaveStateAtom, 'saving')
    try {
      const updated = await window.electronAPI.updateSystemPrompt(id, input)
      if (revision === revisions.get(id)) {
        store.set(promptConfigAtom, (previous) => ({
          ...previous,
          prompts: previous.prompts.map((prompt) => prompt.id === updated.id ? updated : prompt),
        }))
      }
      if (queue.pendingCount() === 0) store.set(promptSaveStateAtom, 'saved')
    } catch (error) {
      store.set(promptSaveStateAtom, 'error')
      throw error
    }
  }, PROMPT_SAVE_DEBOUNCE_MS, { maxWaitMs: PROMPT_SAVE_MAX_WAIT_MS, onError: reportFailure })
  const autosave = ((id: string, input: SystemPromptUpdateInput): void => {
    if (store.get(promptDeletingIdsAtom).includes(id) || !store.get(promptConfigAtom).prompts.some((prompt) => prompt.id === id)) return
    revisions.set(id, (revisions.get(id) ?? 0) + 1)
    store.set(promptConfigAtom, (previous) => ({
      ...previous,
      prompts: previous.prompts.map((prompt) => prompt.id === id ? { ...prompt, ...input } : prompt),
    }))
    store.set(promptSaveStateAtom, 'pending')
    queue.queue(id, input)
  }) as SystemPromptAutosave
  autosave.flush = async () => {
    try {
      await queue.flush()
      store.set(promptSaveStateAtom, 'saved')
    } catch (error) {
      reportFailure()
      throw error
    }
  }
  autosave.remove = (id) => {
    const existing = deletions.get(id)
    if (existing) return existing
    const prompt = store.get(promptConfigAtom).prompts.find((item) => item.id === id)
    if (!prompt || prompt.isBuiltin) return Promise.reject(new Error('无法删除该提示词'))
    store.set(promptDeletingIdsAtom, (ids) => [...ids, id])
    // 先锁定两处编辑器，再提交已有草稿；失败时解除锁并保留条目供重试。
    const deletion = autosave.flush().then(async () => {
      await window.electronAPI.deleteSystemPrompt(id)
      store.set(promptConfigAtom, (previous) => ({
        ...previous,
        prompts: previous.prompts.filter((item) => item.id !== id),
        defaultPromptId: previous.defaultPromptId === id ? 'builtin-default' : previous.defaultPromptId,
      }))
      if (store.get(selectedPromptIdAtom) === id) store.set(selectedPromptIdAtom, 'builtin-default')
      revisions.delete(id)
    }).finally(() => {
      deletions.delete(id)
      store.set(promptDeletingIdsAtom, (ids) => ids.filter((item) => item !== id))
    })
    deletions.set(id, deletion)
    return deletion
  }
  queues.set(store, autosave)
  return autosave
}

export function useSystemPromptAutosave(): SystemPromptAutosave {
  const store = useStore()
  const autosave = React.useMemo(() => getSystemPromptAutosave(store), [store])
  React.useEffect(() => () => { void autosave.flush().catch(() => {}) }, [autosave])
  return autosave
}
