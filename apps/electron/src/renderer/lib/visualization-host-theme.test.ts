import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { applyEffectiveRadii, createVisualizationThemeChannel, type VisualizationHostTheme } from './visualization-host-theme'

function hostTheme(tokens: Record<string, string>, fontFamily = 'Inter, sans-serif'): VisualizationHostTheme {
  return { tokens, fontFamily }
}

/** 手动 resolve 的 whenSkinCssApplied 替身：模拟“皮肤 CSS 还在异步注入”。 */
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('可视化宿主主题通道', () => {
  test('换肤：DOM 属性变化先发一次，皮肤 CSS 落地后必须补发新值', async () => {
    // 这正是「切换皮肤后颜色不跟随」的回归测试：
    // class 变了、skin-css 还没落地时读到的是旧皮肤的值，落地后必须再发一次。
    let skinCssApplied = false
    const gate = deferred()
    const published: VisualizationHostTheme[] = []
    const channel = createVisualizationThemeChannel({
      read: () => hostTheme({ '--background': skinCssApplied ? '200 30% 12%' : '0 0% 100%' }),
      skinId: () => 'skin-a',
      whenSkinCssApplied: () => gate.promise,
      publish: (theme) => published.push(theme),
    })

    channel.publishNow()
    expect(published.map((theme) => theme.tokens['--background'])).toEqual(['0 0% 100%'])

    const refresh = channel.refresh()
    skinCssApplied = true
    gate.resolve()
    await refresh
    expect(published.map((theme) => theme.tokens['--background'])).toEqual(['0 0% 100%', '200 30% 12%'])
  })

  test('只有皮肤 CSS 落地、DOM 属性没变时也要发布（启动/刷新皮肤库）', async () => {
    const published: VisualizationHostTheme[] = []
    const channel = createVisualizationThemeChannel({
      read: () => hostTheme({ '--background': '150 10% 14%' }),
      skinId: () => 'skin-b',
      whenSkinCssApplied: async () => {},
      publish: (theme) => published.push(theme),
    })
    await channel.refresh()
    expect(published).toHaveLength(1)
    expect(published[0]?.tokens['--background']).toBe('150 10% 14%')
  })

  test('同值不重复发布（避免每轮 MutationObserver 都重渲图表 / 重发消息）', async () => {
    let reads = 0
    const published: VisualizationHostTheme[] = []
    const channel = createVisualizationThemeChannel({
      read: () => { reads++; return hostTheme({ '--foreground': '0 0% 98%' }) },
      skinId: () => null,
      whenSkinCssApplied: async () => {},
      publish: (theme) => published.push(theme),
    })
    channel.publishNow()
    channel.publishNow()
    await channel.refresh()
    expect(reads).toBe(3)
    expect(published).toHaveLength(1)
  })

  test('字体族变化也要发布（皮肤可以换字体栈）', () => {
    const published: VisualizationHostTheme[] = []
    const channel = createVisualizationThemeChannel({
      read: () => hostTheme({ '--foreground': '0 0% 98%' }, published.length === 0 ? 'Inter' : 'Source Serif'),
      skinId: () => 'skin-c',
      whenSkinCssApplied: async () => {},
      publish: (theme) => published.push(theme),
    })
    channel.publishNow()
    channel.publishNow()
    expect(published.map((theme) => theme.fontFamily)).toEqual(['Inter', 'Source Serif'])
  })

  test('并发 refresh：先发起后落地的取值不得覆盖新皮肤', async () => {
    const first = deferred()
    const second = deferred()
    const gates = [first, second]
    const skins = ['skin-a', 'skin-b']
    let index = 0
    const published: VisualizationHostTheme[] = []
    const channel = createVisualizationThemeChannel({
      read: () => hostTheme({ '--background': skins[index] === 'skin-a' ? '0 0% 100%' : '0 0% 7%' }),
      skinId: () => skins[index] ?? null,
      whenSkinCssApplied: () => gates[index]!.promise,
      publish: (theme) => published.push(theme),
    })

    const stale = channel.refresh()
    index = 1
    const fresh = channel.refresh()
    gates[1]!.resolve()
    await fresh
    gates[0]!.resolve()
    await stale
    expect(published.map((theme) => theme.tokens['--background'])).toEqual(['0 0% 7%'])
  })

  test('几何 intent 来自 app 真元素的探针，不是 --radius 字面值', () => {
    // 旧屏微光（terminal-dark）把“全局直角”写成 `[class*="rounded"]{border-radius:0}`——
    // 这条文档级规则进不了 iframe，只能靠在 app 文档里探真元素把它变成 token 值。
    const probed = (values: Record<string, string | null>) => (className: string) => values[className] ?? null
    expect(applyEffectiveRadii({ '--radius': '2px' }, probed({ 'rounded-lg': '0px', 'rounded-full': '0px' })))
      .toEqual({ '--radius': '0px', '--radius-pill': '0px' })
    // 默认主题：探针读到的就是 token 值本身，不应改变观感
    expect(applyEffectiveRadii({ '--radius': '0.625rem' }, probed({ 'rounded-lg': '10px', 'rounded-full': '9999px' })))
      .toEqual({ '--radius': '10px', '--radius-pill': '9999px' })
  })

  test('探针探不到/值不合法时保留原 token（CSS 未加载不让片段掉成直角）', () => {
    const missing = applyEffectiveRadii({ '--radius': '0.625rem' }, () => null)
    expect(missing).toEqual({ '--radius': '0.625rem' })
    expect(applyEffectiveRadii({}, () => 'red')).toEqual({})
    expect(applyEffectiveRadii({}, () => '')).toEqual({})
  })

  test('可视化组件不得退回各自挂 MutationObserver 取主题', () => {
    // 只监听 documentElement 属性 = 换肤时读到未落地的旧 token 且再无补发信号。
    // 这个坑已经踩过一次，用源码守卫把它钉住（见 lib/visualization-host-theme.ts 顶部说明）。
    for (const file of ['../components/visualization/VisualizationHost.tsx', '../components/visualization/NativeVisualizationChart.tsx']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(source).toContain('useVisualizationHostTheme')
      expect(source).not.toContain('new MutationObserver')
    }
  })
})
