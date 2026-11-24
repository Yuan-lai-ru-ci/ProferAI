import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, parse, resolve, sep, isAbsolute } from 'node:path'
import type { AgentWorkspace, PresetReference } from '@profer/shared'
import type { CoreConfig } from './config'
import type { PiMcpClientManager } from '@profer/agent-provider-pi/pi/mcp-tools'
import { assertSafeSkillSegment } from '@profer/agent-provider-pi/skills/skill-path-security'

export interface CoreResourceOperationContext {
  config: CoreConfig
  mcpManager?: PiMcpClientManager
  workspaces: { list(): AgentWorkspace[] }
  sessions?: { list(): Array<{ id: string; workspaceId?: string; presetId?: string; presetReference?: PresetReference }> }
  automations?: { list(): Array<{ id: string; workspaceId?: string; presetId?: string; presetReference?: PresetReference }> }
}
export interface CoreResourceOperationBody { operation: string; args: unknown[] }
export function resourceObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Core资源参数必须为对象')
  return value as Record<string, unknown>
}
export function resourceText(value: unknown, max = 256): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('Core资源字符串参数无效')
  return value
}
/** 每一级都检查，包括悬空软链；不以existsSync作为安全检查。 */
export function assertResourcePath(path: string): string {
  const target = resolve(path)
  let cursor = parse(target).root
  for (const part of target.slice(cursor.length).split(sep)) {
    cursor = join(cursor, part)
    try { if (lstatSync(cursor).isSymbolicLink() && !(process.platform === 'darwin' && ['/var','/tmp','/etc'].includes(cursor) && realpathSync(cursor) === `/private${cursor}`)) throw new Error(`Core资源不允许软链：${cursor}`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return target
}
export function readResourceObject(path: string): Record<string, unknown> | undefined {
  assertResourcePath(path)
  if (!existsSync(path)) return undefined
  return resourceObject(JSON.parse(readFileSync(path, 'utf8')))
}
export function coreWorkspaceDirectory(context: CoreResourceOperationContext, slug: unknown) {
  const key = resourceText(slug); assertSafeSkillSegment(key, 'workspaceSlug')
  const workspace = context.workspaces.list().find(item => item.slug === key)
  if (!workspace) throw new Error('Core资源所属工作区不存在')
  if (workspace.storageMode === 'project' && (!workspace.rootPath || !isAbsolute(workspace.rootPath))) throw new Error('Core项目根必须为绝对路径')
  const root = workspace.storageMode === 'project'
    ? resourceText(workspace.rootPath, 8192) : join(context.config.workspaceRoot, key)
  assertResourcePath(root)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error('Core资源所属工作区目录不存在或不是目录')
  const directory = workspace.storageMode === 'project' ? join(root, '.profer') : root
  assertResourcePath(directory)
  return { workspace, directory }
}
