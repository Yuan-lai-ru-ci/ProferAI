/**
 * 模态变暗层回归守卫
 *
 * 背景：独立的整屏 fixed 遮罩层在 macOS 高刷新率外接屏上滚动时会偶发整层漏画一帧，
 * 表现为「遮罩消失、页面亮一下」的闪屏（2026-11-13 逐帧定位：每次只有 1 帧，
 * 像素比值正好等于 50% 遮罩被去掉）。修复方式是把变暗画进对话框自身的
 * `.dialog-dim` 扩散阴影里，不再渲染独立遮罩层。
 *
 * 这里用源码断言锁住三条不变量，避免后续重构把独立遮罩层加回来：
 * 1. 共享 Dialog 不再渲染 <DialogPrimitive.Overlay>；
 * 2. 共享 Dialog 内容与设置弹窗都带 `dialog-dim`；
 * 3. `.dialog-dim` 的定义仍然覆盖整个视口（100vmax）。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '../../../../..')

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8')
}

describe('模态变暗层', () => {
  test('共享 Dialog 不再渲染独立 Overlay，改用 dialog-dim', () => {
    const source = read('packages/ui/src/primitives/dialog.tsx')

    expect(source).not.toContain('<DialogOverlay />')
    expect(source).not.toContain('DialogPrimitive.Overlay')
    expect(source).toContain('dialog-dim')
  })

  test('设置弹窗不再有独立遮罩，内容带 dialog-dim', () => {
    const source = read('apps/electron/src/renderer/components/settings/SettingsDialog.tsx')

    expect(source).not.toContain('DialogPrimitive.Overlay')
    expect(source).toContain('dialog-dim')
  })

  test('.dialog-dim 用 100vmax 扩散阴影覆盖整个视口', () => {
    const css = read('apps/electron/src/renderer/styles/globals.css')
    const start = css.indexOf('.dialog-dim {')
    expect(start).toBeGreaterThan(-1)

    const rule = css.slice(start, css.indexOf('}', start) + 1)
    expect(rule).toContain('100vmax')
    expect(rule).toContain('var(--overlay)')
  })
})
