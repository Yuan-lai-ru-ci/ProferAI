import { describe, expect, test } from 'bun:test'
import { resolveDelegationPermissionMode } from './agent-collaboration-utils'

const modes = ['plan', 'auto', 'bypassPermissions'] as const

describe('resolveDelegationPermissionMode', () => {
  for (const parent of modes) {
    for (const requested of modes) {
      test(`claude: 子会话请求权限不会高于父会话 (${parent} / ${requested})`, () => {
        const effective = resolveDelegationPermissionMode(parent, requested, 'claude')
        const ranks = { plan: 0, auto: 1, bypassPermissions: 2 } as const
        expect(ranks[effective]).toBeLessThanOrEqual(ranks[parent])
      })
    }
  }

  test('Pi 子会话固定完全自动，避免并行子会话逐个等待审批', () => {
    for (const parent of modes) {
      for (const requested of [...modes, undefined]) {
        expect(resolveDelegationPermissionMode(parent, requested, 'pi')).toBe('bypassPermissions')
      }
    }
  })

  test('Claude 子会话未指定请求权限时继承父会话权限', () => {
    expect(resolveDelegationPermissionMode('plan', undefined, 'claude')).toBe('plan')
    expect(resolveDelegationPermissionMode('auto', undefined, 'claude')).toBe('auto')
  })
})
