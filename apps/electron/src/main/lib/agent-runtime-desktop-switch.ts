/**
 * agent-runtime-desktop-switch —— 桌面 `runAgent`（IPC SEND_MESSAGE）的 runtime 开关。
 *
 * 与既有三个运行时开关保持同一入口读取模式：桌面链默认关闭，显式设置为 `1` 时走新链。
 * 未设置或设置为其他值时继续走旧编排器；显式 `0` 也保持旧链，便于发布后止损。
 *
 * ## 读取点 / 生效点 / 回退方式
 *
 * - **读取点**：`agent-service.ts` 的 `runAgent()` 入口，**在任何 await 之前**读一次，得到本轮链条
 *   （`resolveDesktopRunChain`）。本模块只提供判定，不自己接线；接线清单见 lane 交付的
 *   `integration-requests.md`（IR-D1）。
 * - **生效点**：只作用于**新发起**的 run。`claim` 发生在读取之后、且 run 一旦取得 owner，
 *   owner 与终态口径就由取得时那条链负责到底 —— 运行中改环境变量不会让在飞的 run 换链
 *   （`ownership` 登记表按 sessionId + token 释放，token 校验保证旧链的 finally 清不掉新 run）。
 * - **回退方式**：未设置、设置为 `0` 或其他非 `1` 值时走旧链；只有显式设置为 `1` 才走新链。
 * - 新链只作用于**新发起**的 run。`claim` 发生在读取之后，运行中修改环境变量不会切换在飞 run。
 *
 * ## 为什么桌面开关需要单独存在
 *
 * 桌面入口的渲染层可见投影比 headless 多（backlog 回放、STREAM_COMPLETE/STREAM_ERROR 专用 IPC、
 * draft 晋升回调、删除/分叉守卫），因此不能直接复用 headless 那个开关：
 * 打开它会把桌面 SEND_MESSAGE 之外的一堆 headless 入口一起带走，无法归因。
 *
 * ## 与 Goal 的关系
 *
 * Goal 输入（`goalRunId` / `reportGoalResult` / `onRuntimeSessionId` / `onRuntimeMessage`）
 * 在桌面同样**必须回旧链**（GAP-6 未关闭），与 `canUseRuntimeHeadless` 保持同一组排除条件。
 */

import type { AgentSendInput } from '@profer/shared'

/** 桌面 runtime 开关的环境变量名。 */
export const DESKTOP_RUNTIME_SWITCH_ENV = 'PROFER_RUNTIME_DESKTOP'

/** 本轮 run 实际使用的执行链。 */
export type DesktopRunChain = 'runtime' | 'orchestrator'

/** 环境变量快照的最小形态（便于测试注入，不直接读全局）。 */
export type DesktopSwitchEnv = Readonly<Record<string, string | undefined>>

/** 显式设为 1 才启用；缺省保持旧编排器。 */
export function isDesktopRuntimeSwitchEnabled(env: DesktopSwitchEnv = process.env): boolean {
  return env[DESKTOP_RUNTIME_SWITCH_ENV] === '1'
}

/**
 * 该输入是否允许走桌面 runtime 链。
 *
 * 排除条件与 `canUseRuntimeHeadless` 一致（Goal 回调面未下沉，GAP-6）：
 * 任一 Goal 字段存在即回旧链，避免 Goal 的执行权 / 结果回调在新链丢失。
 */
export function canUseRuntimeDesktop(
  input: Pick<AgentSendInput, 'goalRunId' | 'reportGoalResult' | 'goalProposal' | 'onRuntimeSessionId' | 'onRuntimeMessage'>,
  env: DesktopSwitchEnv = process.env,
): boolean {
  if (!isDesktopRuntimeSwitchEnabled(env)) return false
  return !input.goalRunId
    && !input.reportGoalResult
    && !input.goalProposal
    && !input.onRuntimeSessionId
    && !input.onRuntimeMessage
}

/**
 * 桌面 run 的链条判定 —— 调用点唯一需要调用的函数。
 *
 * 只读一次环境变量并返回本轮链条，调用点据此选择 `runDesktopRuntimeAgent` 或旧分支。
 * 刻意返回字符串而不是布尔：调用点必须显式写出两条分支，避免「顺手加个 if 就当成等价」。
 */
export function resolveDesktopRunChain(
  input: Pick<AgentSendInput, 'goalRunId' | 'reportGoalResult' | 'goalProposal' | 'onRuntimeSessionId' | 'onRuntimeMessage'>,
  env: DesktopSwitchEnv = process.env,
): DesktopRunChain {
  return canUseRuntimeDesktop(input, env) ? 'runtime' : 'orchestrator'
}
