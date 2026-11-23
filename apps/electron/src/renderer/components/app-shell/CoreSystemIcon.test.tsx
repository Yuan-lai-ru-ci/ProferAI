import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CoreSystemIcon, resolveCoreSystemIcon } from './CoreSystemIcon'
import { CORE_SYSTEM_ICONS } from './core-system-icons'

describe('Core 系统标识', () => {
  test('平台别名统一，发行版不覆盖 macOS / Windows', () => {
    for (const platform of ['darwin', 'macOS', 'mac']) expect(resolveCoreSystemIcon(platform)).toBe('apple')
    for (const platform of ['win32', 'Windows']) expect(resolveCoreSystemIcon(platform)).toBe('windows11')
    expect(resolveCoreSystemIcon('darwin', 'ubuntu')).toBe('apple')
    expect(resolveCoreSystemIcon('win32', 'debian')).toBe('windows11')
    expect(resolveCoreSystemIcon('linux', ' Ubuntu ')).toBe('ubuntu')
    expect(resolveCoreSystemIcon('linux', 'opensuse-tumbleweed')).toBe('opensuse')
    expect(resolveCoreSystemIcon('linux', 'rhel')).toBe('redhat')
  })

  test('未知发行版使用 Linux，未知远端不猜成本机', () => {
    expect(resolveCoreSystemIcon('linux')).toBe('linux')
    expect(resolveCoreSystemIcon('linux', 'unknown-distro')).toBe('linux')
    expect(resolveCoreSystemIcon(undefined, 'ubuntu')).toBeUndefined()
    expect(resolveCoreSystemIcon('unknown')).toBeUndefined()
    const html = renderToStaticMarkup(<CoreSystemIcon />)
    expect(html).toContain('lucide-cpu')
    expect(html).not.toContain('data-core-system')
  })

  test('所有品牌使用单色矢量且可命名，无外部图片和请求', () => {
    expect(Object.keys(CORE_SYSTEM_ICONS)).toHaveLength(24)
    for (const [id, icon] of Object.entries(CORE_SYSTEM_ICONS)) {
      const html = renderToStaticMarkup(<CoreSystemIcon platform={id === 'apple' ? 'darwin' : id === 'windows11' ? 'win32' : id} />)
      expect(icon.path.length).toBeGreaterThan(50)
      // 每个品牌资源本身由同一组件绘制，不混用彩色位图。
      const svg = renderToStaticMarkup(<CoreSystemIcon platform={id === 'apple' ? 'darwin' : id === 'windows11' ? 'win32' : id === 'freebsd' ? 'freebsd' : 'linux'} osId={id} className="size-4" />)
      expect(svg).toContain(`data-core-system="${id}"`)
      expect(svg).toContain('fill="currentColor"')
      expect(svg).toContain('viewBox="0 0 24 24"')
      expect(svg).not.toContain('<img')
      expect(html).not.toContain('https://')
    }
    expect(renderToStaticMarkup(<CoreSystemIcon platform="linux" osId="ubuntu" />)).toContain('aria-label="Ubuntu"')
  })
})
