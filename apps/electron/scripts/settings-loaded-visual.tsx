import { mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { atom, createStore } from 'jotai/vanilla'
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { createLoadedHost, nodeText } from './settings-loaded-visual-host'
import { TooltipProvider } from '@profer/ui/primitives/tooltip'

// 只在单独 Bun 进程运行。全局对象是环境接口 fixture，未创建 DOM、Electron 或真实交互 renderer。
const output = resolve(process.argv[2] ?? '.context/visual/settings-loaded')
const assets = resolve(import.meta.dir, '../dist/renderer/assets')
const renderer = resolve(import.meta.dir, '../src/renderer')
mkdirSync(output, { recursive: true })
let store = createStore()
type Target = Parameters<typeof store.get>[0]
type Writable = Parameters<typeof store.set>[0]
const setters = new Map<Writable, (value: unknown) => unknown>()
const setterFor = (target: Writable) => {
  let setter = setters.get(target)
  if (!setter) { setter = (value) => store.set(target, value); setters.set(target, setter) }
  return setter
}
mock.module('jotai', () => ({ atom, getDefaultStore: () => store, useAtom: (target: Writable) => [store.get(target), setterFor(target)], useAtomValue: (target: Target) => store.get(target), useSetAtom: setterFor, useStore: () => store }))
const toasts: unknown[] = []
mock.module('sonner', () => ({ Toaster: () => null, toast: { error: (...args: unknown[]) => toasts.push(args), success: (...args: unknown[]) => toasts.push(args), warning: (...args: unknown[]) => toasts.push(args), info: (...args: unknown[]) => toasts.push(args) } }))
for (const resource of ['manifest.json', 'skin.css']) {
  const path = resolve(import.meta.dir, `../resources/skin-template/${resource}`)
  mock.module(`${path}?raw`, () => ({ default: readFileSync(path, 'utf8') }))
}
const storage = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Mac fixture SSR', platform: 'MacIntel', onLine: true } })
Object.defineProperty(globalThis, '__APP_VERSION__', { configurable: true, value: '0.16.0-fixture' })
const timers = new Map<number, string>()
let timerId = 0
const schedule = (kind: string) => () => { const id = ++timerId; timers.set(id, kind); return id }
const unschedule = (id: number) => timers.delete(id)
Object.assign(globalThis, { setInterval: schedule('interval'), clearInterval: unschedule, setTimeout: schedule('timeout'), clearTimeout: unschedule })
const listeners = new Set<unknown>()
const subscribe = (listener: unknown) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const calls: string[] = []
let scenario = 'loaded'
const environment = { checkedAt: 1, nodejs: { installed: true, version: '22.0.0-fixture', meetsMinimum: true, meetsRecommended: true, path: '/fixture/node' }, git: { installed: true, version: '2.0-fixture', meetsRequirement: true, path: '/fixture/git' } }
const settings = { browserHomeUrl: 'https://fixture.invalid', quickTaskEnabled: true, archiveAfterDays: 7, inputCompactViewportHeight: 700, inputCompactMinHeight: 60, inputCompactMaxHeight: 140, autoCleanupTempOnStart: true, autoCleanupArchivedDays: 30, lastEnvironmentCheck: environment }
const channel = { id: 'fixture-channel', name: 'Fixture 模型连接', provider: 'openai', enabled: true, apiKey: '', baseUrl: 'https://fixture.invalid/v1', agentRuntimes: ['pi'], createdAt: 1, updatedAt: 1, models: [{ id: 'fixture-model', name: 'Fixture 推理模型', enabled: true, source: 'manual' }] }
const reads: Record<string, unknown> = {
  getSettings: settings, getAutoLaunch: false, getRuntimeStatus: { initialized: true, bun: { available: true, version: 'fixture' }, git: { available: true }, node: { available: true } },
  getSkins: [], refreshSkins: [], getSkinPreview: null, getSystemPromptConfig: { prompts: [{ id: 'fixture-prompt', name: 'Fixture 项目审查', content: '检查类型、错误处理与验证结果。', isBuiltin: false, createdAt: 1, updatedAt: 1 }], defaultPromptId: 'fixture-prompt', appendDateTimeAndUserName: true },
  getChatTools: [], getChatToolCredentials: {}, getVoiceDictationSettings: { enabled: false, appId: '', accessToken: '', resourceId: '', endpointMode: 'async', language: 'auto', outputMode: 'profer-input' }, checkMicrophonePermission: { status: 'granted', canRequest: false },
  getStorageStats: { totalBytes: 8388608, calculatedAt: 1, categories: [{ key: 'temp-files', label: '临时文件（Fixture）', bytes: 2097152, count: 3, orphanBytes: 0, orphanCount: 0, hasOrphans: false }, { key: 'agent-sessions', label: 'Agent 会话（Fixture）', bytes: 6291456, count: 8, orphanBytes: 1024, orphanCount: 1, hasOrphans: true }] },
  listChannels: [channel], getAccountCapabilities: { commercialMode: true, canSelfConfig: true }, getOfficialModelHealth: [], listAgentWorkspaces: [],
  getPocketModeStatus: { enabled: false, running: false, port: 4096, defaultPort: 7788, localUrl: null, lanUrl: null, token: null, error: null }, getProferApkQr: null,
  getFeishuMultiConfig: { bots: [] }, getFeishuMultiStatus: { bots: {} }, getFeishuConfig: { enabled: false, appId: '', appSecret: '' }, listFeishuBindings: [],
  refreshLarkCliStatus: { node: { available: true }, npm: { available: true }, npx: { available: true }, cli: { available: false }, auth: { state: 'unknown', userLabel: null, scopeCount: null, checkedAt: null }, checkedAt: 1, error: null }, getLarkMcpStatus: { configured: false, appId: null, configuredAt: null, enabledWorkspaces: [] },
  getDingTalkMultiConfig: { bots: [] }, getDingTalkConfig: { enabled: false, clientId: '', clientSecret: '' }, getWeChatConfig: { enabled: false }, getWeChatStatus: { status: 'disconnected' },
  getProxySettings: { enabled: false, mode: 'system', manualUrl: '' }, listPlugins: [],
}
const api = Object.fromEntries(Object.entries(reads).map(([name, value]) => [name, async () => { calls.push(name); if (scenario === 'storage-error' && name === 'getStorageStats') throw new Error('Fixture storage read failure'); return value }]))
Object.assign(api, {
  getPlatformInfo: () => ({ platform: 'darwin', arch: 'arm64' }),
  updateSettings: async () => { calls.push('updateSettings(mock only)') },
  auth: { getTeamAuth: async () => ({ baseUrl: 'https://fixture.invalid', token: 'fixture-only' }), getAuthStatus: async () => ({ isLoggedIn: true, teamEmail: 'fixture@example.invalid' }), listDevices: async () => ({ ok: true, currentDeviceId: 'fixture-device', devices: [{ id: 'fixture-slot', deviceId: 'fixture-device', deviceName: 'Fixture Mac', platform: 'darwin', appVersion: '0.16.0-fixture', createdAt: 1, lastUsedAt: 1 }] }) },
  updater: { getChangelog: async () => [{ version: '0.16.0', date: '2026-10-08', notes: '## Fixture 更新日志\n- 设置界面加载完成样本。' }] },
  onPluginsChanged: subscribe, onWeChatStatusChanged: subscribe, onLarkLoginEvent: subscribe, onLarkMcpLoginEvent: subscribe,
})
const unknownApi = new Set<string>()
const guardedApi = new Proxy(api, { get(target, name: string) { if (name in target) return target[name]; unknownApi.add(name); return () => { throw new Error(`Fixture 未声明 API：${name}`) } } })
Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: guardedApi, innerHeight: 820, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener: (_: string, listener: unknown) => listeners.add(listener), removeEventListener: (_: string, listener: unknown) => listeners.delete(listener), setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout } })
const pricing = { plans: Object.fromEntries([['standard', 2915], ['plus', 4915], ['pro', 9915]].map(([id, monthly]) => [id, { id, name: `Fixture ${id}`, monthlyRmb: monthly, yearlyRmb: Number(monthly) * 10, welcomeBonus: 73, dailyDrip: 9 }])), vip: { price: 70015, discount: 0.85, extraDrip: 23 }, adminWechat: 'fixture-contact' }
const responses: Record<string, unknown> = {
  '/v1/account/credits': { balance: 123450000, lifetimeConsumed: 23450000, balancePackage: 100000000, balanceReferral: 3450000, balancePurchased: 20000000, inviteCode: 'FIXTURE', subscription: { hasSubscription: true, status: 'active', plan: 'plus', dailyDripRate: 20 }, membershipTier: 'plus', isVip: false },
  '/v1/account/credits/usage?limit=30': { logs: [{ id: 'fixture-log', model: 'fixture-model', prompt_tokens: 400, completion_tokens: 600, total_tokens: 1000, cost_credits: 50000, duration_ms: 1800, success: 1, stream: 1, created_at: 1 }] },
  '/v1/account/credits/usage-by-model?days=30': [{ model: 'fixture-model', requests: 3, total_tokens: 3000, prompt_tokens: 1200, completion_tokens: 1800, total_cost: 150000 }],
  '/v1/account/config/plans': pricing,
  '/v1/account/credits/recharge-config': { enabled: true, manualFallback: true, rate: 100, presetsRmb: [10, 50, 100], customMinRmb: 1, customMaxRmb: 500, currency: 'CNY', adminWechat: 'fixture-contact' },
}
Object.assign(api, { getCommercialMode: async () => true })
Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (url: string, options?: RequestInit) => {
  if (options?.method && options.method !== 'GET') throw new Error('Fixture 禁止付款/修改请求')
  const address = new URL(url)
  if (address.origin !== 'https://fixture.invalid') throw new Error(`禁止外部网络：${address.origin}`)
  const path = `${address.pathname}${address.search}`
  calls.push(`fetch fixture ${path}`)
  if (!(path in responses)) throw new Error(`Fixture 未声明请求：${path}`)
  return new Response(JSON.stringify(responses[path]), { status: scenario === 'pricing-error' && path === '/v1/account/config/plans' ? 503 : 200, headers: { 'content-type': 'application/json' } })
} })
const { SettingsPanel } = await import('../src/renderer/components/settings/SettingsPanel')
const { settingsTabAtom } = await import('../src/renderer/atoms/settings-tab')
const { appModeAtom } = await import('../src/renderer/atoms/app-mode')
const { authStatusAtom } = await import('../src/renderer/atoms/identity-atoms')
const { developerModeEnabledAtom } = await import('../src/renderer/atoms/developer-mode')
const { themeModeAtom } = await import('../src/renderer/atoms/theme')
const { userProfileAtom } = await import('../src/renderer/atoms/user-profile')
const { selectedPromptIdAtom } = await import('../src/renderer/atoms/system-prompt-atoms')
const { updateStatusAtom } = await import('../src/renderer/atoms/updater')
const componentNames = new Set(['SettingsPanel'])
for (const file of readdirSync(join(renderer, 'components/settings')).filter((file) => file.endsWith('.tsx') && !file.includes('.test.'))) {
  for (const match of readFileSync(join(renderer, 'components/settings', file), 'utf8').matchAll(/(?:export\s+)?function\s+([A-Z][A-Za-z0-9_]*)\s*\(/g)) componentNames.add(match[1]!)
}
const cssFiles = readdirSync(assets).filter((file) => file.endsWith('.css'))
const css = cssFiles.map((file) => readFileSync(join(assets, file), 'utf8').replace(/url\(([^)]+)\)/g, (original, raw: string) => {
  const name = raw.replace(/["']/g, '').replace(/^.*\//, '')
  const filePath = join(assets, name)
  if (!existsSync(filePath)) return original
  const mime = extname(name) === '.woff2' ? 'font/woff2' : 'application/octet-stream'
  return `url(data:${mime};base64,${readFileSync(filePath).toString('base64')})`
})).join('\n')
function embedImages(markup: string) {
  return markup.replace(/src="([^"]+)"/g, (original, path: string) => {
    if (path.startsWith('data:')) return original
    const absolute = path.startsWith('/') ? path : resolve(renderer, path)
    if (!existsSync(absolute)) throw new Error(`图片资源未内联：${path}`)
    return `src="data:image/${extname(absolute).slice(1)};base64,${readFileSync(absolute).toString('base64')}"`
  })
}
const cases = ['general', 'usage', 'account', 'channels', 'agent', 'prompts', 'tools', 'appearance', 'shortcuts', 'bots', 'proxy', 'data-management', 'credits', 'subscription', 'developer', 'plugins', 'about'] as const
const records: Record<string, unknown>[] = []
async function snapshot(page: typeof cases[number], tone: 'light' | 'dark', variant = 'loaded', selectRemote?: string) {
  scenario = variant
  store = createStore(); setters.clear(); calls.length = 0; toasts.length = 0; unknownApi.clear()
  store.set(settingsTabAtom, page); store.set(appModeAtom, page === 'agent' ? 'agent' : 'chat'); store.set(authStatusAtom, { isLoggedIn: true, teamEmail: 'fixture@example.invalid' }); store.set(developerModeEnabledAtom, true); store.set(themeModeAtom, tone); store.set(userProfileAtom, { userName: 'Fixture 用户', avatar: 'F' }); store.set(selectedPromptIdAtom, 'fixture-prompt'); store.set(updateStatusAtom, { status: 'available', version: '0.16.0' })
  const host = createLoadedHost(() => <TooltipProvider delayDuration={0}><SettingsPanel onClose={() => {}} /></TooltipProvider>, componentNames)
  try {
    await host.settle()
    if (selectRemote) await host.click(selectRemote)
    if (variant === 'cleanup-confirmation') {
      await host.click('清理')
      if (!host.elements().some((node) => node.props.open === true)) throw new Error('真实清理事件未打开确认状态')
    }
    const content = nodeText(host.tree())
    const markup = embedImages(renderToStaticMarkup(host.tree()))
    if (unknownApi.size) throw new Error(`未声明 API：${[...unknownApi].join(', ')}`)
    const name = `${page}${selectRemote ? `-${selectRemote}` : ''}-${variant}-${tone}`
    for (const width of [1080, 420]) {
      const html = `<!DOCTYPE html><html lang="zh-CN" class="${tone === 'dark' ? 'dark' : ''}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name} / Fixture SSR</title><style>${css}</style><style>body{margin:0;background:hsl(var(--background));color:hsl(var(--foreground));font-family:system-ui,sans-serif}.evidence{padding:8px 16px;font-size:12px;color:hsl(var(--muted-foreground))}#loaded{height:1000px;margin:12px auto;max-width:1080px;background:hsl(var(--dialog-surface));overflow:hidden;border-radius:8px}@media(max-width:767px){#loaded{margin:8px;height:1000px}}</style></head><body><div class="evidence">Fixture 数据 · 真实组件 effects 已稳定 · SSR 视觉样本 · ${tone} / ${width}px</div><div id="loaded">${markup}</div></body></html>`
      const escaped = html.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
      const file = `${name}-${width}.html`
      writeFileSync(join(output, file), `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${name}</title></head><body style="margin:0"><iframe title="${name} / ${width}px" style="display:block;width:${width}px;height:1060px;border:0" srcdoc="${escaped}"></iframe></body></html>`)
      records.push({ file, page, tone, width, variant, remote: selectRemote, sha256: createHash('sha256').update(html).digest('hex'), calls: [...calls], text: content, toasts: [...toasts], modalOpen: variant === 'cleanup-confirmation', modalVisible: false })
    }
  } finally {
    host.dispose()
    if (listeners.size || timers.size) throw new Error(`清理遗漏：listeners=${listeners.size}, timers=${timers.size}`)
  }
}
for (const tone of ['light', 'dark'] as const) {
  for (const page of cases) await snapshot(page, tone)
  for (const remote of ['飞书', '微信', '钉钉', '用法', '品牌素材']) await snapshot('bots', tone, 'loaded', remote)
  await snapshot('data-management', tone, 'storage-error')
  await snapshot('subscription', tone, 'pricing-error')
  await snapshot('data-management', tone, 'cleanup-confirmation')
}
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), fixture: true, boundary: '隔离 hook effects + 原组件/primitives SSR；不是 Electron 焦点/键盘/真实 DOM 交互证据', cssFiles, records, excluded: ['tutorial: SettingsPanel 点击教程后打开主区 tab，不在面板内渲染', 'team/openapi/devices 独立页: 当前 SettingsPanel 不提供导航（devices 已在 account 嵌套覆盖）', 'modal: Radix portal SSR 不输出到页面，未替换 portal 或虚构 DOM'] }, null, 2))
console.log(`已生成 ${records.length} 个 loaded/error 视觉样本：${output}`)
