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

  test('includes the manual handoff node and keeps it visible by default', () => {
    const nodes = createAgentComposerToolbarItems({
      model: 'model',
      runtime: 'runtime',
      permissionMode: 'permission',
      preset: 'preset',
      attach: 'attach',
      contextUsage: 'usage',
      handoff: 'handoff',
      graph: 'graph',
    })
    expect(nodes.map((item) => item.key)).toContain('handoff')
    expect(nodes.find((item) => item.key === 'handoff')?.visible).toBe(true)

    // AgentView 用的是数组重载，别让新条目只在一半装配路径里生效。
    const items = createAgentComposerToolbarItems([{ key: 'handoff', node: 'handoff' }])
    expect(items.map((item) => item.key)).toEqual(['handoff'])
    expect(items[0]?.visible).toBe(true)
  })
})
