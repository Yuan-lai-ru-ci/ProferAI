import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { ProxyConfig } from '@profer/shared'
import { loadProxyConfigAtom, proxyConfigAtom, updateProxyConfigAtom } from './proxy-atoms'

const config: ProxyConfig = { enabled: true, mode: 'manual', manualUrl: 'http://127.0.0.1:7890' }

async function withApi(api: object, run: () => Promise<void>): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: api } })
  try { await run() } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

describe('代理配置真实 atom 行为', () => {
  test('Given IPC 加载失败 When 页面加载 Then 抛出错误且不伪造默认配置', async () => {
    const store = createStore()
    await withApi({ getProxySettings: async () => { throw new Error('fixture-load') } }, async () => {
      await expect(store.set(loadProxyConfigAtom)).rejects.toThrow('fixture-load')
      expect(store.get(proxyConfigAtom)).toBeNull()
    })
  })

  test('Given 已有配置 When 刷新失败 Then 保留已有配置供回退', async () => {
    const store = createStore()
    store.set(proxyConfigAtom, config)
    await withApi({ getProxySettings: async () => { throw new Error('fixture-load') } }, async () => {
      await expect(store.set(loadProxyConfigAtom)).rejects.toThrow('fixture-load')
      expect(store.get(proxyConfigAtom)).toBe(config)
    })
  })

  test('Given 保存失败 When atom 更新 Then 不提交失败的新值', async () => {
    const store = createStore()
    store.set(proxyConfigAtom, config)
    await withApi({ updateProxySettings: async () => { throw new Error('fixture-save') } }, async () => {
      await expect(store.set(updateProxyConfigAtom, { ...config, enabled: false })).rejects.toThrow('fixture-save')
      expect(store.get(proxyConfigAtom)).toBe(config)
    })
  })

  test('Given 保存成功 When atom 更新 Then IPC 与缓存使用同一配置', async () => {
    const store = createStore()
    const next = { ...config, enabled: false }
    let received: ProxyConfig | undefined
    await withApi({ updateProxySettings: async (input: ProxyConfig) => { received = input } }, async () => {
      await store.set(updateProxyConfigAtom, next)
      expect(received).toBe(next)
      expect(store.get(proxyConfigAtom)).toBe(next)
    })
  })
})
