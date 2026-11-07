/**
 * 会话存储路径解析（electron-free）。
 *
 * 配置目录解析已下沉到 `@profer/user-memory`，与画像 / 全局记忆共用同一份实现。
 * 这样 CLI 和 GUI 对「配置根在哪」只有一个答案，不会再出现 CLI 不认
 * `PROFER_CONFIG_DIR` 而主进程认的历史漂移。
 *
 * 目录布局（与主进程 config-paths.ts 保持一致）：
 *   <configDir>/agent-sessions.json         会话索引
 *   <configDir>/agent-sessions/<id>.jsonl   单会话消息
 *   <configDir>/user-profile.json           用户名 / 头像
 *   <configDir>/global-memory/              用户画像与全局记忆
 */
import { join } from 'node:path'
import { resolveConfigDir } from '@profer/user-memory'
import type { ConfigDirOptions } from '@profer/user-memory'

export type PathOptions = ConfigDirOptions

export { resolveConfigDir }

export function getSessionsIndexPath(opts: PathOptions = {}): string {
  return join(resolveConfigDir(opts), 'agent-sessions.json')
}

export function getSessionsDir(opts: PathOptions = {}): string {
  return join(resolveConfigDir(opts), 'agent-sessions')
}

export function getSessionMessagesPath(id: string, opts: PathOptions = {}): string {
  return join(getSessionsDir(opts), `${id}.jsonl`)
}
