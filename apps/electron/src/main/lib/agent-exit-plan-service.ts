/** Electron 保留原单例；Core 使用独立实例，共用计划审批的动作解释。 */
import { AgentExitPlanService } from '@profer/agent-runtime/exit-plan-service'
export * from '@profer/agent-runtime/exit-plan-service'
export const exitPlanService = new AgentExitPlanService()
