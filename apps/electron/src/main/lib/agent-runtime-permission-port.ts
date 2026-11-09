import type { PermissionPort, RuntimeCanUseTool, RuntimeCanUseToolOptions, RuntimePermissionResult } from '@profer/agent-runtime'
import { permissionService } from './agent-permission-service'
import { askUserService } from './agent-ask-user-service'
import { exitPlanService } from './agent-exit-plan-service'
import { createPlanModeGatedCanUseTool, getAgentRuntimePlanMode } from './agent-runtime-plan-mode'

function toRuntimeCanUseToolOptions(options: Parameters<ReturnType<typeof permissionService.createCanUseTool>>[2]): RuntimeCanUseToolOptions {
  return {
    signal: options.signal,
    suggestions: options.suggestions,
    blockedPath: options.blockedPath,
    decisionReason: options.decisionReason,
    decisionReasonType: options.decisionReasonType,
    classifierApprovable: options.classifierApprovable,
    toolUseID: options.toolUseID,
    agentID: options.agentID,
    title: options.title,
    displayName: options.displayName,
    description: options.description,
  }
}

function toRuntimePermissionResult(result: Awaited<ReturnType<ReturnType<typeof permissionService.createCanUseTool>>>): RuntimePermissionResult {
  return {
    ...result,
    ...(result.behavior === 'allow' && result.updatedPermissions ? { updatedPermissions: result.updatedPermissions } : {}),
  }
}


export interface ElectronPermissionPortOptions extends Pick<PermissionPort, 'canUseTool'> {
  /**
   * 会话是否处于 `bypassPermissions`（无人值守语义）。
   *
   * 权限服务本身不看模式：它只区分「只读自动放行 / 其余询问」。旧链靠 SDK 在
   * bypassPermissions 时直接跳过 canUseTool；Pi 的工具是本地包装，每次调用都会回调，
   * 于是 automation / 飞书 / 调试通道在没有界面的情况下会永久停在「等待批准」。
   * 判定由宿主注入（run facts 或会话元数据），这里只负责短路。
   */
  isBypassPermissions?: (sessionId: string) => boolean
}

export function createElectronPermissionPort(options?: ElectronPermissionPortOptions): PermissionPort {
  return {
    createCanUseTool(input) {
      const callback = permissionService.createCanUseTool(
        input.sessionId,
        input.sendPermissionRequest,
        input.handleAskUser as Parameters<typeof permissionService.createCanUseTool>[2],
        input.sendAskUserRequest,
      )
      const inner: RuntimeCanUseTool = async (toolName, toolInput, canUseOptions) => {
        // 完全自动模式：不打断、不落审批请求（与 Claude SDK 在 bypassPermissions 下的行为同义）。
        if (options?.isBypassPermissions?.(input.sessionId)) {
          return {
            behavior: 'allow' as const,
            updatedInput: toolInput,
            ...(canUseOptions.toolUseID ? { toolUseID: canUseOptions.toolUseID } : {}),
          }
        }
        return toRuntimePermissionResult(await callback(toolName, toolInput, toRuntimeCanUseToolOptions(canUseOptions) as Parameters<typeof callback>[2]))
      }
      // 计划模式责任方：入口注册了本轮控制器时，EnterPlanMode / ExitPlanMode 与 plan 只读工具面
      // 必须在进入通用权限判定之前拦截；未注册时保持既有行为（不新增隐藏默认值）。
      const planMode = getAgentRuntimePlanMode(input.sessionId)
      if (!planMode) return inner
      return createPlanModeGatedCanUseTool({
        controller: planMode,
        inner,
        requestExitPlanApproval: ({ toolInput, signal }) =>
          exitPlanService.handleExitPlanMode(input.sessionId, toolInput, signal, request => planMode.emitExitPlanRequest(request)) as Promise<RuntimePermissionResult>,
      })
    },
    handleAskUserQuestion(input) {
      return askUserService.handleAskUserQuestion(input.sessionId, input.toolInput, input.signal, input.sendToRenderer)
    },
    handleExitPlanMode(input) {
      return exitPlanService.handleExitPlanMode(input.sessionId, input.toolInput, input.signal, input.sendToRenderer) as Promise<RuntimePermissionResult>
    },
    clearSessionPending(sessionId) {
      // turn 结束只清权限与计划审批；AskUser 由用户交互或会话删除结束。
      permissionService.clearSessionPending(sessionId)
      exitPlanService.clearSessionPending(sessionId)
    },
    clearSessionWhitelist(sessionId) {
      permissionService.clearSessionWhitelist(sessionId)
    },
    ...(options?.canUseTool ? { canUseTool: options.canUseTool } : {}),
  }
}
