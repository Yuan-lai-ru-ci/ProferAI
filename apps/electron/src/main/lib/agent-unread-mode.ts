/**
 * 「会话未读」策略模式的唯一来源（主进程）。
 *
 * 只会有一个判据：设置项 `manualReadConfirmEnabled`。主进程的所有未读相关调用点
 * （run 启动 / run 终态 / 归档 / 移动端命令）都必须经过本 helper 取模式，
 * **不要**在各处重复读 `getSettings().manualReadConfirmEnabled`——散落读字段会让
 * 以后新增路径时漏判，也会让「一处换判据」变成多点改动。
 *
 * 为什么不放进 `agent-unread-policy.ts`：那个模块是纯函数模块（无 Electron / 无 IO），
 * 单测直接 import 它；把 settings-service（会读磁盘、依赖 config-paths）拉进去会污染其纯度。
 */

import type { AgentUnreadPolicyMode } from './agent-unread-policy'
import { getSettings } from './settings-service'

/**
 * 当前生效的未读策略模式。
 *
 * - `'auto'`（默认）：关闭态，等价于既有行为（自动清除）。
 * - `'manual'`：开启态，已读需用户显式确认。
 *
 * `settings-service` 的 `updateSettings` 会同步更新内存缓存，因此设置切换后
 * **无需重启**，主进程下一次判定即读到新值。
 */
export function getAgentUnreadPolicyMode(): AgentUnreadPolicyMode {
  return getSettings().manualReadConfirmEnabled === true ? 'manual' : 'auto'
}
