export function generateModelSnapshots(output: string, assets: string): void {
  const css = readdirSync(assets).filter((file) => file.endsWith('.css')).map((file) => readFileSync(join(assets, file), 'utf8')).join('\n')
  const channel: Channel = {
    id: 'fixture-visual', name: '项目模型连接', provider: 'openai', enabled: true,
    baseUrl: 'https://fixture.invalid/v1', agentBaseUrl: 'https://fixture.invalid/anthropic',
    apiKey: '', agentRuntimes: ['pi', 'claude'], createdAt: 1, updatedAt: 1,
    models: [{ id: 'fixture-model', name: '项目推理模型', enabled: true, source: 'manual' }],
  }
  for (const tone of ['light', 'dark']) {
    const store = createStore()
    store.set(themeModeAtom, tone === 'dark' ? 'dark' : 'light')
    const markup = renderToStaticMarkup(<Provider store={store}><ChannelForm channel={channel} onSaved={() => {}} onCancel={() => {}} /></Provider>)
    const html = `<!DOCTYPE html><html lang="zh-CN" class="${tone === 'dark' ? 'dark' : ''}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0;background:hsl(var(--background));color:hsl(var(--foreground));font-family:system-ui,sans-serif}main{max-width:780px;margin:24px auto;padding:24px}@media(max-width:767px){main{margin:0;padding:16px}}</style></head><body><main>${markup}</main></body></html>`
    writeFileSync(join(output, `model-form-${tone}.html`), html)
    const escaped = html.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
    writeFileSync(join(output, `model-form-${tone}-narrow.html`), `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0"><iframe title="模型编辑" style="display:block;width:420px;height:1100px;border:0" srcdoc="${escaped}"></iframe></body></html>`)
  }
}
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createStore, Provider } from 'jotai'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SettingsPanel } from '../src/renderer/components/settings/SettingsPanel'
import { settingsTabAtom } from '../src/renderer/atoms/settings-tab'
import { promptConfigAtom, selectedPromptIdAtom } from '../src/renderer/atoms/system-prompt-atoms'
import { themeModeAtom } from '../src/renderer/atoms/theme'
import { ChannelForm } from '../src/renderer/components/settings/ChannelForm'
import type { Channel } from '@profer/shared'

// 隔离 SSR：只生成真实组件首屏，不运行 effects 或真实 IPC，不替代 Electron 交互验收。
export function generateSettingsSnapshots(output: string, assets: string): void {
  const cssFiles = readdirSync(assets).filter((file) => file.endsWith('.css'))
  const css = cssFiles.map((file) => readFileSync(join(assets, file), 'utf8')).join('\n')
  const pages = [
    { id: 'general' as const, label: '通用' },
    { id: 'usage' as const, label: '使用偏好' },
    { id: 'account' as const, label: '账户与资料' },
    { id: 'prompts' as const, label: '提示词管理' },
    { id: 'tools' as const, label: 'Chat 工具' },
    { id: 'appearance' as const, label: '外观设置' },
  ]
  for (const tone of ['light', 'dark']) {
    for (const page of pages) {
      const store = createStore()
      store.set(themeModeAtom, tone === 'dark' ? 'dark' : 'light')
      store.set(settingsTabAtom, page.id)
      store.set(promptConfigAtom, { prompts: [{ id: 'snapshot', name: '项目审查', content: '请检查类型、错误处理和验证结果。', isBuiltin: false, createdAt: 1, updatedAt: 1 }], appendDateTimeAndUserName: true })
      store.set(selectedPromptIdAtom, 'snapshot')
      const markup = renderToStaticMarkup(<Provider store={store}><SettingsPanel onClose={() => {}} tabsOverride={pages.map((item) => ({ ...item, icon: null }))} /></Provider>)
      const html = `<!DOCTYPE html><html lang="zh-CN" class="${tone === 'dark' ? 'dark' : ''}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${page.label}</title><style>${css}</style><style>body{margin:0;background:hsl(var(--background));color:hsl(var(--foreground));font-family:system-ui,sans-serif}#snapshot{height:760px;max-width:1080px;margin:16px auto;background:hsl(var(--dialog-surface));border:1px solid hsl(var(--surface-border));border-radius:8px;overflow:hidden}@media(max-width:767px){#snapshot{margin:12px;height:calc(100dvh - 24px)}}</style></head><body><div id="snapshot">${markup}</div></body></html>`
      writeFileSync(join(output, `settings-${page.id}-${tone}.html`), html)
      const escaped = html.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
      writeFileSync(join(output, `settings-${page.id}-${tone}-narrow.html`), `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0"><iframe title="${page.label}" style="display:block;width:420px;height:820px;border:0" srcdoc="${escaped}"></iframe></body></html>`)
    }
  }
}