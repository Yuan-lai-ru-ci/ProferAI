import { expect, mock, test } from 'bun:test'
import type { ProferPermissionMode } from '@profer/shared'
let cap: ProferPermissionMode | undefined
mock.module('./agent-session-manager', () => ({ getAgentSessionMeta: () => ({ id: 'child' }) }))
mock.module('./agent-session-permission-policy', () => ({ resolveSessionDelegationPermissionCap: () => cap }))
const { exitPlanService } = await import('./agent-exit-plan-service')

for (const limit of [undefined, 'auto', 'plan'] as const) {
  test(`Given 父 cap=${limit} When 用户批准完全自动 Then 返回值和运行中审批结果保持同一边界`, async () => {
    cap = limit
    let requestId = ''
    const pending = exitPlanService.handleExitPlanMode('child', {}, new AbortController().signal, request => { requestId = request.requestId })
    const result = exitPlanService.respondToExitPlanMode({ requestId, action: 'approve_auto' })
    const permission = await pending
    if (limit === 'plan') {
      expect(permission.behavior).toBe('deny')
      expect(result?.targetMode).toBeNull()
    } else {
      const mode = limit === 'auto' ? 'auto' : 'bypassPermissions'
      expect(result?.targetMode).toBe(mode)
      expect(permission).toMatchObject({ behavior: 'allow', targetMode: mode })
    }
  })
}
