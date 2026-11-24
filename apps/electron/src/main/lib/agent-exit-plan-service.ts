/** Electron 保留原单例；Core 使用独立实例，共用计划审批的动作解释。 */
import { AgentExitPlanService } from '@profer/agent-runtime/exit-plan-service'
import type { ExitPlanModeResponse } from '@profer/shared'
import { getAgentSessionMeta } from './agent-session-manager'
import { resolveSessionDelegationPermissionCap } from './agent-session-permission-policy'
export * from '@profer/agent-runtime/exit-plan-service'

class ElectronExitPlanService extends AgentExitPlanService {
  override respondToExitPlanMode(response: ExitPlanModeResponse): ReturnType<AgentExitPlanService['respondToExitPlanMode']> {
    // 在共享服务 resolve 审批 Promise 前收敛动作，让返回给 IPC 与运行控制器的模式一致。
    // 只约束外部父级 cap；预设默认 plan 不妨碍可信用户批准退出。
    if (response.action === 'approve_auto' || response.action === 'approve_edit') {
      const request = this.getPendingRequests().find(item => item.requestId === response.requestId)
      const cap = request ? resolveSessionDelegationPermissionCap(getAgentSessionMeta(request.sessionId)) : undefined
      if (cap === 'plan') return super.respondToExitPlanMode({ ...response, action: 'deny' })
      if (cap === 'auto' && response.action === 'approve_auto') {
        return super.respondToExitPlanMode({ ...response, action: 'approve_edit' })
      }
    }
    return super.respondToExitPlanMode(response)
  }
}

export const exitPlanService = new ElectronExitPlanService()
