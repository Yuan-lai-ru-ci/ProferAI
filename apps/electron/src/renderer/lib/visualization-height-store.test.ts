import { beforeEach, describe, expect, test } from 'bun:test'
import {
  configureVisualizationHeightStorage,
  flushVisualizationHeights,
  readPersistedVisualizationHeight,
  rememberVisualizationHeight,
} from './visualization-height-store'

function fakeStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    raw: data,
  }
}

describe('可视化容器高度持久化', () => {
  beforeEach(() => { configureVisualizationHeightStorage(null) })

  test('写入后能读回，未写过的 key 为 null', () => {
    configureVisualizationHeightStorage(fakeStorage())
    rememberVisualizationHeight('k1', 3600)
    flushVisualizationHeights()
    expect(readPersistedVisualizationHeight('k1')).toBe(3600)
    expect(readPersistedVisualizationHeight('k2')).toBe(null)
  })

  test('落盘内容是纯数字，条数封顶，坏数据不抛', () => {
    const storage = fakeStorage()
    configureVisualizationHeightStorage(storage)
    for (let index = 0; index < 260; index += 1) rememberVisualizationHeight(`k${index}`, 100 + index)
    flushVisualizationHeights()
    const parsed = JSON.parse(storage.raw.get('profer:visualization-heights')!) as Record<string, number>
    expect(Object.keys(parsed).length).toBe(200)
    expect(Object.values(parsed).every((value) => typeof value === 'number')).toBe(true)

    configureVisualizationHeightStorage({ getItem: () => '{ 坏 JSON', setItem: () => {} })
    expect(readPersistedVisualizationHeight('k1')).toBe(null)
  })

  test('storage 不可用时降级成内存缓存，不抛错', () => {
    configureVisualizationHeightStorage(null)
    rememberVisualizationHeight('k1', 900)
    expect(readPersistedVisualizationHeight('k1')).toBe(900)
    flushVisualizationHeights()
    rememberVisualizationHeight('k1', -5) // 非法值忽略
    expect(readPersistedVisualizationHeight('k1')).toBe(900)
    expect(readPersistedVisualizationHeight('not-written')).toBe(null)
  })
})
