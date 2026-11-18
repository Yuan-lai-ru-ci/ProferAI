import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AgentSessionMeta } from '@profer/shared'
import { assertProjectPathSafe, isValidProjectSessionId } from '@profer/session-store/project-session-paths'
import { resolveProjectInstructions, type ProjectInstructionDiagnostic } from '@profer/agent-provider-pi/pi/project-instruction'
import type { ProferProjectInstructionFile } from '@profer/agent-provider-pi/pi/resource-loader-overrides'
import type { CoreConfig } from './config'
import type { CoreWorkspaceStore } from './workspaces'

export interface CoreProjectContext {
  promptSections: string[]
  additionalDirectories: string[]
  projectInstructionFiles: ProferProjectInstructionFile[]
  diagnostics: ProjectInstructionDiagnostic[]
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
function absolute(path: string): string {
  if (typeof path !== 'string' || !path || path.includes('\0') || !isAbsolute(path)) throw new Error('Core上下文路径必须是当前宿主的绝对路径')
  return resolve(path)
}
function attachedPaths(value: unknown, directory: boolean): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('附加资源配置必须是路径数组')
  return value.map((value: unknown) => {
    if (typeof value !== 'string') throw new Error('附加资源路径无效')
    const path = absolute(value)
    if (!existsSync(path) || (directory ? !statSync(path).isDirectory() : !statSync(path).isFile())) throw new Error(`附加资源不存在或类型不匹配：${path}`)
    return realpathSync(path)
  })
}
function section(name: string, paths: string[]): string {
  // JSON转义保留路径原值，避免文件名中的换行或标签变成提示词结构。
  return `<${name}>\n${paths.map(path => JSON.stringify(path)).join('\n')}\n</${name}>`
}

/** 只解析当前Core索引中的显式工作区；不发现父目录、其他Core或附加目录中的项目规则。 */
export function resolveCoreProjectContext(input: {
  config: Pick<CoreConfig, 'configDir' | 'workspaceRoot' | 'coreId'>
  workspaces: Pick<CoreWorkspaceStore, 'list'>
  session: AgentSessionMeta
  cwd: string
}): CoreProjectContext {
  const { config, session } = input
  if (!isValidProjectSessionId(session.id)) throw new Error('Core上下文会话身份无效')
  const workspace = input.workspaces.list().find(item => item.id === session.workspaceId)
  if (!workspace) throw new Error('Core上下文工作区不存在')
  if (!workspace.slug || workspace.slug === '.' || workspace.slug === '..' || /[/\\:\u0000-\u001f]/.test(workspace.slug)) throw new Error('Core上下文工作区路径身份无效')
  const configRoot = absolute(config.configDir)
  const managedRoot = absolute(config.workspaceRoot)
  const project = workspace.storageMode === 'project'
  const root = project ? absolute(workspace.rootPath ?? '') : join(managedRoot, workspace.slug)
  if (!project) assertProjectPathSafe(managedRoot, root)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error('Core上下文工作区目录不可用')
  const canonicalRoot = realpathSync(root)
  const cwd = absolute(input.cwd)
  if (!existsSync(cwd) || !statSync(cwd).isDirectory() || realpathSync(cwd) !== canonicalRoot) throw new Error('Core上下文cwd与所属工作区不匹配')
  const workspaceConfig = project ? join(root, '.profer') : root
  const configFile = join(workspaceConfig, 'config.json')
  assertProjectPathSafe(root, configFile)
  let attached: { attachedDirectories?: unknown; attachedFiles?: unknown } = {}
  if (existsSync(configFile)) {
    const parsed: unknown = JSON.parse(readFileSync(configFile, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('工作区附加资源配置无效')
    attached = parsed
  }
  const directories = [...attachedPaths(session.attachedDirectories, true), ...attachedPaths(attached.attachedDirectories, true)]
  const files = [...attachedPaths(session.attachedFiles, false), ...attachedPaths(attached.attachedFiles, false)]
  const workbench = join(configRoot, 'session-workspaces', session.id)
  const workspaceFiles = join(workspaceConfig, 'workspace-files')
  assertProjectPathSafe(configRoot, workbench)
  assertProjectPathSafe(root, workspaceFiles)
  const additionalDirectories = new Set<string>([canonicalRoot, ...directories, ...files.map(file => dirname(file))])
  for (const path of [workbench, workspaceFiles]) {
    if (!existsSync(path)) continue
    if (!statSync(path).isDirectory()) throw new Error(`Core上下文资源不是目录：${path}`)
    additionalDirectories.add(realpathSync(path))
  }
  const manifest = project ? resolveProjectInstructions({ projectRoot: canonicalRoot, targetPath: canonicalRoot }) : undefined
  // 再校验真实祖先，覆盖解析器中普通文件位于符号链接目录下的情况。
  const sources = manifest?.sources.filter(source => inside(canonicalRoot, realpathSync(source.path))) ?? []
  const projectInstructionFiles = sources.map(source => ({ path: source.path, content: source.content }))
  const promptSections = [
    `当前执行位置：Profer Core${config.coreId ? ` ${JSON.stringify(config.coreId)}` : ''}；工作区 ${JSON.stringify(workspace.id)}；会话 ${JSON.stringify(session.id)}。文件路径均属于本Core宿主。`,
    `会话工作台：${JSON.stringify(workbench)}；工作区共享文件：${JSON.stringify(workspaceFiles)}。本轮上传附件保存在会话工作台 attachments 子目录；只使用消息中明确提供的附件路径，不搜索其他会话。`,
    ...(directories.length ? [section('attached_directories', [...new Set(directories)])] : []),
    ...(files.length ? [section('attached_files', [...new Set(files)])] : []),
  ]
  return { promptSections, additionalDirectories: [...additionalDirectories], projectInstructionFiles,
    diagnostics: [...(manifest?.diagnostics ?? []), ...(manifest?.sources.filter(source => !sources.includes(source)).map(source => ({ path: source.path, message: '已忽略真实路径位于项目根目录外的指令文件' })) ?? [])] }
}
