import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

test('diff 外容器与 Shadow DOM 样式使用系统滚动三态且隐藏横条但保留横滚', () => {
  const css = readFileSync(new URL('./diff-scroll.css', import.meta.url), 'utf8')
  const component = readFileSync(new URL('./DiffView.tsx', import.meta.url), 'utf8')
  for (const source of [css, component]) {
    for (const state of ['idle', 'hover', 'active']) expect(source).toContain(`var(--scrollbar-thumb-${state})`)
    expect(source).not.toContain('light-dark(')
  }
  expect(component).toContain('[data-code]::-webkit-scrollbar:horizontal')
  expect(component).toContain('overflow-auto')
  expect(component).not.toContain('.diff-scroll [data-code]')
})
