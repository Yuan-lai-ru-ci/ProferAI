import { describe, expect, test } from 'bun:test'
import { createAgentComposerToolbarItems } from './agent-composer-toolbar-config'

describe('Agent composer toolbar descriptor', () => {
  test('keeps the model as a fixed primary action and conditionally includes optional nodes', () => {
    const items = createAgentComposerToolbarItems({
      model: 'model',
      runtime: 'runtime',
      permissionMode: 'permission',
      preset: 'preset',
      attach: 'attach',
      contextUsage: 'usage',
    })
    expect(items.map((item) => item.key)).toEqual([
      'model',
      'attach',
      'runtime',
      'permission-mode',
      'preset',
      'context-usage',
    ])
    expect(items[0]?.canOverflow).toBe(false)
  })
})

test('无用量时不创建工具栏项目，包括溢出菜单候选', () => {
  const items = createAgentComposerToolbarItems({ model: 'm', runtime: 'r', permissionMode: 'p', preset: 's', attach: 'a' })
  expect(items.some(item => item.key === 'context-usage')).toBe(false)
})
