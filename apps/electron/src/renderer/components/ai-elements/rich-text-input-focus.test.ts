import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const styles = readFileSync(new URL('../../styles/globals.css', import.meta.url), 'utf8')
const input = readFileSync(new URL('./rich-text-input.tsx', import.meta.url), 'utf8')
const innerFocusSelector = '[data-profer-navigation-region="conversation"] .agent-input-surface .rich-text-input .ProseMirror:focus-visible'
const navigationFocusSelector = '[data-profer-navigation-region] [tabindex]:not([tabindex="-1"]):focus-visible'

function rule(selector: string): string {
  const start = styles.indexOf(`${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  return styles.slice(start, styles.indexOf('}', start) + 1)
}

describe('输入卡片焦点反馈', () => {
  test('正文编辑区覆盖通用导航焦点框，不在末行下方重复画横线', () => {
    const focusedEditor = rule(innerFocusSelector)
    expect(focusedEditor).toContain('outline: none;')
    expect(focusedEditor).toContain('box-shadow: none;')
    expect(styles.indexOf(innerFocusSelector)).toBeGreaterThan(styles.indexOf(navigationFocusSelector))
  })

  test('外层卡片聚焦效果、工具按钮和其他导航目标仍保留焦点提示', () => {
    expect(rule('.theme-mist-paper-dark .agent-input-surface:focus-within')).toContain('box-shadow: 0 0 0 3px')
    expect(rule(navigationFocusSelector)).toContain('outline: 2px solid hsl(var(--ring));')
    expect(rule('[data-profer-navigation-region="toolbar"] button:focus-visible')).toContain('box-shadow: inset 0 0 0 2px')
  })

  test('编辑器仍可键盘聚焦，折叠按钮和光标逻辑不受样式清理影响', () => {
    expect(input).toContain("tabindex: '0'")
    expect(input).toContain('onClick={() => setIsManuallyCollapsed((prev) => !prev)}')
    expect(rule(innerFocusSelector)).not.toContain('caret-color:')
    expect(rule(innerFocusSelector)).not.toContain('pointer-events:')
  })
})
