import { describe, expect, test } from 'bun:test'
import { resolveDelegationPermissionMode } from './agent-collaboration-utils'

const modes = ['plan', 'auto', 'bypassPermissions'] as const

describe('resolveDelegationPermissionMode', () => {
  for (const runtime of ['claude', 'pi'] as const) {
    for (const parent of modes) {
      for (const requested of modes) {
        test(`${runtime}: 子会话请求权限不会高于父会话 (${parent} / ${requested})`, () => {
          const effective = resolveDelegationPermissionMode(parent, requested, runtime)
          const ranks = { plan: 0, auto: 1, bypassPermissions: 2 } as const
          expect(ranks[effective]).toBeLessThanOrEqual(ranks[parent])
        })
      }
    }
  }

  test('未指定请求权限时继承父会话权限', () => {
    expect(resolveDelegationPermissionMode('plan', undefined, 'claude')).toBe('plan')
    expect(resolveDelegationPermissionMode('auto', undefined, 'pi')).toBe('auto')
  })
})
