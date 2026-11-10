import { expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { OfvThemePayload } from '@profer/shared'

import { BrowserController, resolvePreviewTheme } from './browser-controller'
import { viewerPreviewThemeSignature } from './browser-preview-service'

/**
 * 换皮肤后，已打开的本地预览要按新主题重载（viewer 页的主题只能烘在 URL 里）；
 * 而**普通网页**在任何情况下都不跟随 app 皮肤 —— 这条边界必须由测试守住。
 *
 * 重载判据是「烘进 URL 的主题参数签名」而不是明暗：两个深色皮肤之间切换时明暗不变，
 * 只比对 light/dark 会漏掉（预览会一直停在上一个皮肤的颜色上）。
 */
interface FakeTab {
  tabId: string
  contents: { isDestroyed: () => boolean }
  isLocalPreview: boolean
  localFilePath: string | null
  localPreviewThemeSignature: string | null
  localPreviewBaseDir: string | null
  lastActivityAt: number
  state: { url: string; trace: unknown[] }
}

const LIGHT: OfvThemePayload = { theme: 'light', tokens: { background: '0 0% 100%', foreground: '0 0% 3.9%' } }
const DARK: OfvThemePayload = { theme: 'dark', tokens: { background: '0 0% 7%', foreground: '0 0% 98%' } }
/** 与 DARK 同色调、不同配色的皮肤（模拟 ocean-dark → forest-dark 这类切换） */
const DARK_SKIN: OfvThemePayload = {
  theme: 'dark',
  tokens: { background: '150 8% 14%', foreground: '140 10% 92%' },
}

function harness() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'profer-preview-theme-')))
  const docPath = join(root, 'sample-legacy.doc')
  writeFileSync(docPath, 'fake doc content')

  const loaded: Array<{ tabId: string; url: string }> = []
  const makeTab = (over: Partial<FakeTab>): FakeTab => ({
    tabId: 'tab',
    contents: { isDestroyed: () => false },
    isLocalPreview: false,
    localFilePath: null,
    localPreviewThemeSignature: null,
    localPreviewBaseDir: null,
    lastActivityAt: 0,
    state: { url: '', trace: [] as unknown[] },
    ...over,
  })
  const previewLight = makeTab({
    tabId: 'preview-light',
    isLocalPreview: true,
    localFilePath: docPath,
    localPreviewThemeSignature: viewerPreviewThemeSignature(LIGHT),
  })
  const previewDark = makeTab({
    tabId: 'preview-dark',
    isLocalPreview: true,
    localFilePath: docPath,
    localPreviewThemeSignature: viewerPreviewThemeSignature(DARK),
  })
  const webTab = makeTab({ tabId: 'web', state: { url: 'https://example.com/', trace: [] as unknown[] } })
  // HTML 本地预览：主题不在它的 URL 里（签名 null），换主题不该重载它
  const htmlPreview = makeTab({ tabId: 'preview-html', isLocalPreview: true, localFilePath: join(root, 'index.html') })
  const sessions = new Map([
    ['session-a', {
      sessionId: 'session-a',
      allowedRoots: [root],
      ledger: [] as unknown[],
      executionSource: 'user',
      tabs: new Map([[previewLight.tabId, previewLight], [webTab.tabId, webTab], [htmlPreview.tabId, htmlPreview]]),
      activeTabId: previewLight.tabId,
    }],
    ['session-b', {
      sessionId: 'session-b',
      allowedRoots: [root],
      ledger: [] as unknown[],
      executionSource: 'user',
      tabs: new Map([[previewDark.tabId, previewDark]]),
      activeTabId: previewDark.tabId,
    }],
  ])

  const controller = new BrowserController()
  const internals = controller as unknown as {
    sessions: Map<string, unknown>
    emit: () => void
    loadUrl: (tab: { tabId: string }, url: string) => Promise<void>
  }
  internals.sessions = sessions
  internals.emit = () => undefined
  internals.loadUrl = async (tab, url) => { loaded.push({ tabId: tab.tabId, url }) }
  return { controller, loaded, previewLight, previewDark, webTab, htmlPreview }
}

const decodeTokens = (url: string): unknown => {
  const raw = new URL(url).searchParams.get('tokens')
  return raw ? JSON.parse(raw) : null
}

test('换主题：本地预览按新主题重载，已是新主题的不重载，普通网页不碰', async () => {
  const h = harness()

  expect(await h.controller.refreshLocalPreviewThemes(DARK)).toBe(1)
  expect(h.loaded).toHaveLength(1)
  expect(h.loaded[0]?.tabId).toBe('preview-light')
  const url = h.loaded[0]!.url
  expect(new URL(url).searchParams.get('theme')).toBe('dark')
  // token 必须一起烘进 URL：皮肤配色靠它到达 viewer 页
  expect(decodeTokens(url)).toEqual(DARK.tokens)
  expect(h.previewLight.localPreviewThemeSignature).toBe(viewerPreviewThemeSignature(DARK))
  // 普通网页与已匹配主题的预览都不产生任何加载
  expect(h.loaded.some((item) => item.tabId === 'web')).toBe(false)
  expect(h.loaded.some((item) => item.tabId === 'preview-dark')).toBe(false)
})

test('HTML 本地预览不跟随主题：它的 URL 里没有主题，重载只会白丢页面状态', async () => {
  const h = harness()

  expect(await h.controller.refreshLocalPreviewThemes(DARK_SKIN)).toBe(2)
  expect(h.loaded.some((item) => item.tabId === 'preview-html')).toBe(false)
  expect(h.htmlPreview.localPreviewThemeSignature).toBeNull()
})

test('同色调皮肤之间切换（dark → 另一个深色皮肤）也要重载', async () => {
  const h = harness()

  expect(await h.controller.refreshLocalPreviewThemes(DARK_SKIN)).toBe(2)
  expect(h.loaded.map((item) => item.tabId).sort()).toEqual(['preview-dark', 'preview-light'])
  expect(decodeTokens(h.loaded[0]!.url)).toEqual(DARK_SKIN.tokens)
})

test('切回浅色：只有仍是深色的预览被重载', async () => {
  const h = harness()
  expect(await h.controller.refreshLocalPreviewThemes(LIGHT)).toBe(1)
  expect(h.loaded[0]?.tabId).toBe('preview-dark')
  expect(new URL(h.loaded[0]!.url).searchParams.get('theme')).toBe('light')
  expect(h.previewLight.localPreviewThemeSignature).toBe(viewerPreviewThemeSignature(LIGHT))
})

test('重载失败只留痕：不标记为已切换（下次仍会重试），也不影响其它标签', async () => {
  const h = harness()
  const internals = h.controller as unknown as { loadUrl: (tab: { tabId: string }, url: string) => Promise<void> }
  internals.loadUrl = async () => { throw new Error('boom') }

  expect(await h.controller.refreshLocalPreviewThemes(DARK)).toBe(0)
  expect(h.previewLight.localPreviewThemeSignature).toBe(viewerPreviewThemeSignature(LIGHT))
  const traces = (h.previewLight.state.trace as Array<{ summary: string; status: string }>)
  expect(traces.some((item) => item.summary.includes('按新主题重载预览失败') && item.status === 'failed')).toBe(true)
})

test('主题来源优先级：显式 > 渲染进程最近同步 > settings 兜底', () => {
  let fallbackCalls = 0
  const fallback = (): 'light' | 'dark' => {
    fallbackCalls += 1
    return 'dark'
  }

  // 显式优先：不去看记忆值，也不去算兜底
  expect(resolvePreviewTheme(LIGHT, DARK, fallback)).toBe(LIGHT)
  expect(fallbackCalls).toBe(0)
  // 没有显式值时用渲染进程最近同步的那份（Agent 打开的预览走这里）
  expect(resolvePreviewTheme(undefined, DARK_SKIN, fallback)).toBe(DARK_SKIN)
  expect(fallbackCalls).toBe(0)
  // 两档都空才按 settings 现算明暗（只保证明暗，皮肤配色仍需渲染进程给）
  expect(resolvePreviewTheme(undefined, null, fallback)).toEqual({ theme: 'dark' })
  expect(fallbackCalls).toBe(1)
})
