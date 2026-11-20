import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { AgentPreset } from '@profer/shared'
import { agentPresetsAtom, agentPresetsLoadedAtom, coreScopedPresetCacheKey, workspacePresetsAtom } from './agent-preset-atoms'
import { coreTargetsAtom } from './core-target-atoms'

function preset(id: string): AgentPreset {
  return { id, name: id, description: '', isBuiltin: false, createdAt: 1, updatedAt: 1 }
}
function target(currentId: string, generation: number) {
  return { currentId, generation, targets: [] }
}

describe('真实 Jotai preset Core 缓存边界', () => {
  test('相同 slug 的不同 Core 数据隔离且切回原代际可读', () => {
    const store = createStore()
    const workspace = workspacePresetsAtom('same-slug')
    store.set(coreTargetsAtom, target('core-a', 1))
    store.set(workspace, [preset('a')])
    store.set(coreTargetsAtom, target('core-b', 2))
    expect(store.get(workspace)).toEqual([])
    store.set(workspace, [preset('b')])
    expect(store.get(workspace).map(item => item.id)).toEqual(['b'])
    store.set(coreTargetsAtom, target('core-a', 1))
    expect(store.get(workspace).map(item => item.id)).toEqual(['a'])
  })
  test('同一 Core 新 generation 不复用旧列表', () => {
    const store = createStore()
    store.set(coreTargetsAtom, target('core-a', 1))
    store.set(workspacePresetsAtom('same-slug'), [preset('old')])
    store.set(coreTargetsAtom, target('core-a', 2))
    expect(store.get(workspacePresetsAtom('same-slug'))).toEqual([])
  })
  test('loaded 缓存按 Core 和 generation 判断，旧 loaded 不阻止新请求', () => {
    const store = createStore()
    const old = target('core-a', 1)
    store.set(agentPresetsLoadedAtom, new Set([coreScopedPresetCacheKey('same-slug', old)]))
    expect(store.get(agentPresetsLoadedAtom).has(coreScopedPresetCacheKey('same-slug', old))).toBe(true)
    expect(store.get(agentPresetsLoadedAtom).has(coreScopedPresetCacheKey('same-slug', target('core-b', 2)))).toBe(false)
    expect(store.get(agentPresetsLoadedAtom).has(coreScopedPresetCacheKey('same-slug', target('core-a', 2)))).toBe(false)
  })
  test('以捕获的旧目标 key 写入迟到结果不污染当前列表', async () => {
    const store = createStore()
    const old = target('core-a', 1)
    const oldKey = coreScopedPresetCacheKey('same-slug', old)
    store.set(coreTargetsAtom, old)
    const pending = Promise.resolve([preset('late')]).then(items => {
      const next = new Map(store.get(agentPresetsAtom))
      next.set(oldKey, items)
      store.set(agentPresetsAtom, next)
    })
    store.set(coreTargetsAtom, target('core-b', 2))
    await pending
    expect(store.get(workspacePresetsAtom('same-slug'))).toEqual([])
    expect(store.get(agentPresetsAtom).get(oldKey)?.[0]?.id).toBe('late')
  })
  test('无 workspace 的 global cache 同样按 Core 隔离', () => {
    const store = createStore()
    store.set(coreTargetsAtom, target('core-a', 1))
    store.set(workspacePresetsAtom(undefined), [preset('global-a')])
    store.set(coreTargetsAtom, target('core-b', 2))
    expect(store.get(workspacePresetsAtom(undefined))).toEqual([])
  })
})
