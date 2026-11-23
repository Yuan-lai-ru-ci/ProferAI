import { expect, mock, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
mock.module('jotai', () => ({ atom: (v: unknown) => v, useAtom: () => [{}, () => {}], useAtomValue: () => null }))
mock.module('@/atoms/environment', () => ({ installerDownloadStatesAtom: {}, installerManifestAtom: {} }))
const { EnvironmentCheckCard } = await import('./EnvironmentCheckCard')
for (const [status, token, text] of [
  ['checking', 'text-muted-foreground', '检测中...'],
  ['success', 'text-success', '已安装'],
  ['warning', 'text-warning', '版本过低'],
  ['error', 'text-destructive', '未安装'],
] as const) {
  test(`Given ${status} When 渲染 Then 图标使用语义色且状态有可见文字`, () => {
    const html = renderToStaticMarkup(<EnvironmentCheckCard name="Node.js" status={status} requirement="需要 Node.js" action={{ type: 'none' }} />)
    expect(html).toContain(token)
    expect(html).toContain(text)
    expect(html).toContain('需要 Node.js')
  })
}
