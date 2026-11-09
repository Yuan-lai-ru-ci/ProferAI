/**
 * 工作区级 Profer 私有路径的识别规则。
 *
 * 刻意不 import electron：主进程装配层（workspace-shadow-git.ts）和
 * `scripts/verify-shadow-git-dev.ts` 都需要这套规则，而脚本跑在普通 bun 进程里。
 *
 * 为什么按「绝对路径」而不是按目录名全局排除：
 * managed 工作区根下的 `skills/`、`workspace-files/`、`sessions/` 是 Profer 自己写的，
 * 但同名目录在用户项目里完全可能是业务源码（例如 Web 项目的 `sessions/`）。
 * 全局按名字排除会静默漏掉用户文件——这正是回退底座最不能犯的错。
 * 所以只对「已知是 Profer 的、位于该工作区根下的那个具体路径」生效。
 */

import { join } from 'node:path'

/** managed 工作区根下由 Profer 自己维护的文件（不属于用户内容）。 */
const MANAGED_ROOT_FILES = [
  'agent-presets.json',
  'agent-presets.json.bak',
  'mcp.json',
  'skill-overrides.json',
  'skill-overrides.json.bak',
] as const

/** managed 工作区根下由 Profer 自己维护的目录。 */
const MANAGED_ROOT_DIRS = ['skills', 'skills-inactive', 'workspace-files', 'sessions', 'attachments'] as const

/**
 * 返回必须排除的绝对路径。
 *
 * - project 模式：`<root>/.profer/`（会话、附件、配置）；
 * - managed 模式：`<root>/` 下的 Profer 配置文件与目录。
 *
 * shadow 仓库自身的路径由调用方追加，不在这里——它不在工作区根内。
 */
export function workspaceShadowExclusions(input: {
  storageMode: 'managed' | 'project'
  rootPath: string
}): string[] {
  if (input.storageMode === 'project') return [join(input.rootPath, '.profer')]
  return [
    ...MANAGED_ROOT_FILES.map((name) => join(input.rootPath, name)),
    ...MANAGED_ROOT_DIRS.map((name) => join(input.rootPath, name)),
  ]
}
