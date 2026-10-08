import { expect, mock, test } from 'bun:test'
import { createStore } from 'jotai'
import { promptConfigAtom, selectedPromptIdAtom } from '../atoms/system-prompt-atoms'
import type { SystemPromptUpdateInput } from '@profer/shared'
mock.module('sonner', () => ({ toast: { error() {} } }))
const { getSystemPromptAutosave, promptSaveStateAtom, promptDeletingIdsAtom } = await import('./useSystemPromptAutosave')

const prompt = { id: 'fixture', name: 'Original', content: 'Original', isBuiltin: false, createdAt: 1, updatedAt: 1 }
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

async function withApi(update: (id: string, input: SystemPromptUpdateInput) => Promise<typeof prompt>, run: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { updateSystemPrompt: update } } })
  try { await run() } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

test('失败草稿跨编辑器保留，共用队列可重试成功', async () => {
  const store = createStore()
  store.set(promptConfigAtom, { prompts: [prompt], appendDateTimeAndUserName: true })
  let attempts = 0
  await withApi(async (_id, input) => {
    if (++attempts === 1) throw new Error('fixture failure')
    return { ...prompt, ...input }
  }, async () => {
    const save = getSystemPromptAutosave(store)
    save(prompt.id, { name: 'Draft' })
    await expect(save.flush()).rejects.toThrow('fixture failure')
    expect(store.get(promptConfigAtom).prompts[0]!.name).toBe('Draft')
    expect(store.get(promptSaveStateAtom)).toBe('error')
    expect(getSystemPromptAutosave(store)).toBe(save)
    await getSystemPromptAutosave(store).flush()
    expect(store.get(promptSaveStateAtom)).toBe('saved')
    expect(attempts).toBe(2)
  })
})

test('慢回执不覆盖新版草稿，写入严格串行且flush等待最新值', async () => {
  const store = createStore()
  store.set(promptConfigAtom, { prompts: [prompt], appendDateTimeAndUserName: true })
  const requests: Array<{ input: SystemPromptUpdateInput; resolve: (value: typeof prompt) => void }> = []
  await withApi((_id, input) => new Promise((resolve) => { requests.push({ input, resolve }) }), async () => {
    const save = getSystemPromptAutosave(store)
    save(prompt.id, { content: 'A' })
    const first = save.flush()
    save(prompt.id, { content: 'B' })
    const second = save.flush()
    expect(requests).toHaveLength(1)
    requests[0]!.resolve({ ...prompt, content: 'A' })
    await tick()
    expect(store.get(promptConfigAtom).prompts[0]!.content).toBe('B')
    expect(requests).toHaveLength(2)
    expect(requests[1]!.input).toEqual({ content: 'B' })
    requests[1]!.resolve({ ...prompt, content: 'B' })
    await Promise.all([first, second])
    expect(store.get(promptSaveStateAtom)).toBe('saved')
    expect(store.get(promptConfigAtom).prompts[0]!.content).toBe('B')
  })
})

test('双编辑器共享删除锁；已有草稿先保存，重复删除共用请求，迟到输入不再落盘', async () => {
  const store = createStore()
  store.set(promptConfigAtom, { prompts: [prompt], defaultPromptId: prompt.id, appendDateTimeAndUserName: true })
  store.set(selectedPromptIdAtom, prompt.id)
  let deletes = 0
  let writes = 0
  let resolveSave!: (value: typeof prompt) => void
  let resolveDelete!: () => void
  await withApi(() => { writes++; return new Promise((resolve) => { resolveSave = resolve }) }, async () => {
    window.electronAPI.deleteSystemPrompt = () => { deletes++; return new Promise((resolve) => { resolveDelete = resolve }) }
    const save = getSystemPromptAutosave(store)
    save(prompt.id, { content: 'Before delete' })
    const first = save.remove(prompt.id)
    const second = getSystemPromptAutosave(store).remove(prompt.id)
    expect(first).toBe(second)
    expect(store.get(promptDeletingIdsAtom)).toEqual([prompt.id])
    save(prompt.id, { content: 'Stale event' })
    expect(store.get(promptConfigAtom).prompts[0]!.content).toBe('Before delete')
    expect(deletes).toBe(0)
    resolveSave({ ...prompt, content: 'Before delete' }); await tick()
    expect(deletes).toBe(1)
    resolveDelete(); await first
    expect(store.get(promptConfigAtom).prompts).toEqual([])
    expect(store.get(promptConfigAtom).defaultPromptId).toBe('builtin-default')
    expect(store.get(selectedPromptIdAtom)).toBe('builtin-default')
    expect(store.get(promptDeletingIdsAtom)).toEqual([])
    save(prompt.id, { name: 'Deleted stale event' }); await save.flush()
    expect(writes).toBe(1)
  })
})

test('删除失败解除共享锁，保留提示词且允许继续编辑后重试', async () => {
  const store = createStore()
  store.set(promptConfigAtom, { prompts: [prompt], appendDateTimeAndUserName: true })
  let deletes = 0
  await withApi(async (_id, input) => ({ ...prompt, ...input }), async () => {
    window.electronAPI.deleteSystemPrompt = async () => { if (++deletes === 1) throw new Error('fixture delete failure') }
    const save = getSystemPromptAutosave(store)
    await expect(save.remove(prompt.id)).rejects.toThrow('fixture delete failure')
    expect(store.get(promptDeletingIdsAtom)).toEqual([])
    expect(store.get(promptConfigAtom).prompts).toHaveLength(1)
    save(prompt.id, { content: 'Retry draft' }); await save.flush()
    expect(store.get(promptConfigAtom).prompts[0]!.content).toBe('Retry draft')
    await save.remove(prompt.id)
    expect(store.get(promptConfigAtom).prompts).toEqual([])
    expect(deletes).toBe(2)
  })
})
