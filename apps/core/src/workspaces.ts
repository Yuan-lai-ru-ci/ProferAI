import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync, lstatSync, readdirSync, realpathSync, unlinkSync } from 'node:fs'
import { basename, isAbsolute, join, resolve, relative, sep } from 'node:path'
import { assertProjectRelocationHistory } from './project-relocation'
import { assertProjectPathSafe } from '@profer/session-store/project-session-paths'
import type { AgentSessionMeta, AgentWorkspace } from '@profer/shared'

interface WorkspaceIndex { version: number; workspaces: AgentWorkspace[]; [key: string]: unknown }

export interface CoreWorkspaceStore {
  list(): AgentWorkspace[]
  createManaged(name: string): AgentWorkspace
  update(id: string, updates: { name?: string; archived?: boolean }): AgentWorkspace
  reorder(orderedIds: string[]): AgentWorkspace[]
  assertRemovable(id: string): AgentWorkspace
  assertManagedDeleteTarget(id: string): AgentWorkspace
  removeManagedAfterCascade(id: string): void
  remove(id: string): void
  relocateProject(input: { id: string; rootPath: string }): { workspace: AgentWorkspace; created: boolean; warnings: string[] }
  bindProject(input: { rootPath: string; name?: string; open?: boolean }): { workspace: AgentWorkspace; created: boolean; warnings: string[] }
}

function slugify(name: string, taken: Set<string>): string {
  const base = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'workspace'
  let slug = base
  let index = 2
  while (taken.has(slug)) slug = `${base}-${index++}`
  return slug
}

const PROJECT_MANIFEST_SCHEMA = 'profer.project/1'
const PROJECT_PRESETS_CONFIG = { schema: 'profer.presets/1', defaultPresetReference: null, defaultPresetExplicitlyCleared: false, disabledGlobalPresetIds: [] as string[], disabledWorkspacePresetIds: [] as string[] }
const PROJECT_GITIGNORE_LINES = ['sessions/', 'blobs/', 'cache/', 'workspace-files/', '.runtime/', 'skill-overrides.json', '*.local.json', '.lock']
const PROJECT_SKELETON_DIRS = ['sessions', 'memory', 'skills', 'skills-inactive', 'workspace-files']
function rollbackCreatedPaths(paths: string[]): void {
  for (const path of [...paths].reverse()) try { if (lstatSync(path).isDirectory()) rmdirSync(path); else unlinkSync(path) } catch { /* 只回滚本次新建且仍可安全移除的路径。 */ }
}
function prepareProjectSkeleton(root: string, name: string): string[] {
  const configDir = join(root, '.profer')
  const manifestPath = join(configDir, 'profer.json')
  // 所有现有路径先校验，包括悬空链接；清单检查必须早于任何补建。
  const directoryPaths = [configDir, ...PROJECT_SKELETON_DIRS.map(dir => join(configDir, dir)), join(configDir, 'presets')]
  const filePaths = ['profer.json', 'profile.md', 'memory/MEMORY.md', 'mcp.json', 'config.json', '.gitignore', 'presets/_config.json', 'agent-presets.json'].map(path => join(configDir, path))
  for (const path of [...directoryPaths, ...filePaths]) {
    assertProjectPathSafe(root, path)
    let stats
    try { stats = lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    if (stats.isSymbolicLink() || (directoryPaths.includes(path) ? !stats.isDirectory() : !stats.isFile())) throw new Error(`项目骨架路径不安全：${path}`)
  }
  let manifest: Record<string, unknown> | undefined
  if (existsSync(manifestPath)) {
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { throw new Error(`项目清单格式损坏，拒绝修改：${manifestPath}`) }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`项目清单不是对象，拒绝修改：${manifestPath}`)
    manifest = parsed as Record<string, unknown>
  }
  const knownSchema = manifest?.schema === undefined || manifest.schema === PROJECT_MANIFEST_SCHEMA
  if (!knownSchema) return [] // 未知版本只读打开，不用当前骨架改写未来项目。
  const created: string[] = []
  try {
    if (!existsSync(configDir)) { mkdirSync(configDir); created.push(configDir) }
    for (const dir of PROJECT_SKELETON_DIRS) {
      const path = join(configDir, dir)
      if (existsSync(path)) { if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error(`项目骨架路径不安全：${path}`); continue }
      mkdirSync(path); created.push(path)
    }
    const legacyPresets = existsSync(join(configDir, 'agent-presets.json'))
    if (!legacyPresets) {
      const path = join(configDir, 'presets')
      if (!existsSync(path)) { mkdirSync(path); created.push(path) }
      else if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error(`项目预设目录不安全：${path}`)
    }
    const files: Array<[string, string]> = [
      ['profile.md', `# ${name}\n\n项目资料与工作方式约定；Agent 会自动读取本文件。\n`],
      [join('memory', 'MEMORY.md'), '# 项目记忆索引\n\n短索引与路由；详细正文写入 `workspace-files/.context/memory-archive/`。\n'],
      ['mcp.json', `${JSON.stringify({ servers: {} }, null, 2)}\n`], ['config.json', '{}\n'],
      ['.gitignore', `${[...PROJECT_GITIGNORE_LINES, ''].join('\n')}`],
      ...(!legacyPresets ? [[join('presets', '_config.json'), `${JSON.stringify(PROJECT_PRESETS_CONFIG, null, 2)}\n`] as [string, string]] : []),
    ]
    for (const [relativePath, content] of files) {
      const path = join(configDir, relativePath)
      if (existsSync(path)) continue
      writeFileSync(path, content, { flag: 'wx' }); created.push(path)
    }
    if (!manifest) {
      const next = { schema: PROJECT_MANIFEST_SCHEMA, name, createdAt: new Date().toISOString(), proferVersion: 'unknown', sessionLayout: 2 }
      writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      created.push(manifestPath)
    }
    return created
  } catch (error) { rollbackCreatedPaths(created); throw error }
}

export function createCoreWorkspaceStore(configDir: string, workspaceRoot: string, desktopIndexPath?: string, listSessions?: () => readonly AgentSessionMeta[], onChanged?: () => void, beforeRelocate?: (workspace: AgentWorkspace) => void, desktopIndexWritable = false): CoreWorkspaceStore {
  // 未显式授权写入时，桌面索引仍是宿主权威，独立Core不得覆盖桌面数据。
  if (desktopIndexPath && !desktopIndexWritable) {
    return {
      list() {
        if (!existsSync(desktopIndexPath)) return []
        const parsed: unknown = JSON.parse(readFileSync(desktopIndexPath, 'utf8'))
        if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 4
          || !('workspaces' in parsed) || !Array.isArray(parsed.workspaces)) throw new Error('桌面工作区索引格式无效')
        return parsed.workspaces.map((value: unknown): AgentWorkspace => {
          if (!value || typeof value !== 'object') throw new Error('桌面工作区索引条目无效')
          const item = value as Partial<AgentWorkspace> & { degradedFromProject?: boolean }
          if (typeof item.id !== 'string' || !item.id || typeof item.name !== 'string'
            || typeof item.slug !== 'string' || !item.slug || item.slug === '.' || item.slug === '..'
            || /[/\\:\u0000]/.test(item.slug)
            || typeof item.createdAt !== 'number' || typeof item.updatedAt !== 'number') throw new Error('桌面工作区索引条目无效')
          const hasProjectRoot = typeof item.rootPath === 'string' && isAbsolute(item.rootPath)
          return {
            ...item,
            id: item.id, name: item.name, slug: item.slug, createdAt: item.createdAt, updatedAt: item.updatedAt,
            storageMode: hasProjectRoot || item.storageMode === 'project' || item.degradedFromProject === true ? 'project' : 'managed',
          }
        })
      },
      createManaged() { throw new Error('桌面工作区索引为只读，请通过桌面管理工作区') },
      update() { throw new Error('桌面工作区索引为只读，请通过桌面管理工作区') },
      reorder() { throw new Error('桌面工作区索引为只读，请通过桌面管理工作区') },
      assertRemovable() { throw new Error('桌面工作区索引为只读，请通过桌面管理工作区') },
      assertManagedDeleteTarget() { throw new Error('桌面工作区索引为只读，请通过桌面管理工作区') },
      removeManagedAfterCascade() { throw new Error('桌面工作区索引为只读，请通过桌面管理工作区') },
      remove() { throw new Error('桌面工作区索引为只读，请通过桌面管理工作区') },
      relocateProject() { throw new Error('桌面工作区索引为只读，请通过桌面管理工作区') },
      bindProject() { throw new Error('桌面工作区索引为只读，请通过桌面管理工作区') },
    }
  }
  const indexPath = desktopIndexPath && desktopIndexWritable ? desktopIndexPath : join(configDir, 'workspaces.json')
  const indexVersion = desktopIndexPath && desktopIndexWritable ? 4 : 1
  const read = (): WorkspaceIndex => {
    if (!existsSync(indexPath)) return { version: indexVersion, workspaces: [] }
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as Partial<WorkspaceIndex>
    if (parsed.version !== indexVersion || !Array.isArray(parsed.workspaces)) throw new Error('Core 工作区索引格式无效')
    const ids = new Set<string>(), slugs = new Set<string>(), roots = new Set<string>()
    const workspaces = parsed.workspaces.map((value: unknown): AgentWorkspace => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Core 工作区索引条目无效')
      const item = value as Partial<AgentWorkspace> & { degradedFromProject?: boolean }
      if (typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.name !== 'string'
        || typeof item.slug !== 'string' || !item.slug || item.slug === '.' || item.slug === '..' || /[/\\:\u0000-\u001f]/.test(item.slug)
        || slugs.has(item.slug.toLowerCase()) || !Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt)) throw new Error('Core 工作区索引条目无效或身份重复')
      ids.add(item.id); slugs.add(item.slug.toLowerCase())
      const project = typeof item.rootPath === 'string' && isAbsolute(item.rootPath)
      if (project) {
        const key = existsSync(item.rootPath!) ? realpathSync(item.rootPath!) : resolve(item.rootPath!)
        if (roots.has(key)) throw new Error('Core 工作区索引包含重复项目根')
        roots.add(key)
      }
      return { ...item, storageMode: project || item.storageMode === 'project' || item.degradedFromProject ? 'project' : 'managed' } as AgentWorkspace
    })
    return { ...parsed, version: indexVersion, workspaces }
  }
  const write = (index: WorkspaceIndex): void => {
    mkdirSync(configDir, { recursive: true })
    const temp = `${indexPath}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(index, null, 2), { mode: 0o600 })
    renameSync(temp, indexPath)
    // 索引是权威；观察者失败不撤销已经提交的写入。
    try { onChanged?.() } catch (error) { console.error('[Core] 工作区变更通知失败，重连后可重新读取：', error) }
  }
  const list = (): AgentWorkspace[] => read().workspaces.slice()
  const create = (name: string, storageMode: 'managed' | 'project', rootPath?: string): AgentWorkspace => {
    const normalizedName = name.trim()
    if (!normalizedName || normalizedName.length > 80) throw new Error('工作区名称不能为空且不能超过 80 个字符')
    const index = read()
    if (index.workspaces.some(item => item.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) throw new Error(`工作区名称「${normalizedName}」已存在`)
    if (rootPath && index.workspaces.some(item => item.storageMode === 'project' && item.rootPath === rootPath)) throw new Error(`该 Linux 项目目录已绑定：${rootPath}`)
    const slug = slugify(normalizedName, new Set(index.workspaces.map(item => item.slug)))
    const now = Date.now()
    const workspace: AgentWorkspace = {
      id: randomUUID(), name: normalizedName, slug, createdAt: now, updatedAt: now,
      type: 'personal', storageMode, ...(rootPath ? { rootPath } : {}),
    }
    index.workspaces.unshift(workspace)
    write(index)
    return workspace
  }
  const update = (id: string, updates: { name?: string; archived?: boolean }): AgentWorkspace => {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)
      || (updates.name !== undefined && typeof updates.name !== 'string')
      || (updates.archived !== undefined && typeof updates.archived !== 'boolean')) throw new Error('工作区修改参数无效')
    const index = read()
    const position = index.workspaces.findIndex(item => item.id === id)
    if (position < 0) throw new Error(`Agent 工作区不存在: ${id}`)
    const existing = index.workspaces[position]!
    if (updates.name !== undefined) {
      const name = updates.name.trim()
      if (!name || name.length > 80) throw new Error('工作区名称不能为空且不能超过 80 个字符')
      if (index.workspaces.some(item => item.id !== id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error(`工作区名称「${name}」已存在`)
    }
    if (updates.archived === true && existing.slug === 'default') throw new Error('默认工作区不能收纳')
    const updated = { ...existing, ...(updates.name !== undefined ? { name: updates.name.trim() } : {}), updatedAt: Date.now() }
    if (updates.archived === true) { updated.archived = true; updated.archivedAt = existing.archived ? existing.archivedAt : Date.now() }
    if (updates.archived === false) { delete updated.archived; delete updated.archivedAt }
    index.workspaces[position] = updated
    write(index)
    return updated
  }
  const reorder = (orderedIds: string[]): AgentWorkspace[] => {
    if (!Array.isArray(orderedIds) || orderedIds.some(id => typeof id !== 'string' || !id)
      || new Set(orderedIds).size !== orderedIds.length) throw new Error('工作区排序ID必须是无重复的非空字符串')
    const index = read()
    const byId = new Map(index.workspaces.map(workspace => [workspace.id, workspace]))
    if (orderedIds.some(id => !byId.has(id))) throw new Error('工作区排序包含未知ID，请刷新后重试')
    const ordered = orderedIds.map(id => byId.get(id)!)
    const selected = new Set(orderedIds)
    // 兼容部分排序；保留请求期间新建或未列出的工作区，不删除、不改归属。
    index.workspaces = [...ordered, ...index.workspaces.filter(workspace => !selected.has(workspace.id))]
    write(index)
    return index.workspaces
  }
  const assertRemovable = (id: string): AgentWorkspace => {
    const index = read()
    const target = index.workspaces.find(item => item.id === id)
    if (!target) throw new Error(`Agent 工作区不存在: ${id}`)
    if (target.slug === 'default') throw new Error('默认工作区不能删除')
    // 有绝对 rootPath 的旧条目也属于外部项目，不能降级为 managed 清理。
    if (target.storageMode === 'project' || (typeof target.rootPath === 'string' && isAbsolute(target.rootPath))) return target
    if (index.workspaces.length <= 1) throw new Error('至少需要保留一个项目')
    assertManagedDeleteTarget(id)
    if (listSessions?.().some(session => session.workspaceId === id)) throw new Error('工作区仍有会话，完整级联删除尚未接入，工作区保留')
    if (!target.slug || target.slug === '.' || target.slug === '..' || /[/\\\\:\u0000]/.test(target.slug)) throw new Error('工作区目录路径异常')
    const directory = resolve(workspaceRoot, target.slug)
    const rel = relative(resolve(workspaceRoot), directory)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('工作区目录路径异常')
    if (existsSync(directory)) {
      if (lstatSync(directory).isSymbolicLink() || !statSync(directory).isDirectory()) throw new Error('工作区目录不安全')
      const actual = realpathSync(directory)
      if (index.workspaces.some(item => item.id !== id && item.rootPath && existsSync(item.rootPath)
        && realpathSync(item.rootPath) === actual)) throw new Error('工作区目录仍是项目根，拒绝删除')
      if (readdirSync(directory).length) throw new Error('工作区仍有文件，完整级联删除尚未接入，文件保留')
    }
    return target
  }
  const assertManagedDeleteTarget = (id: string): AgentWorkspace => {
    const current = read()
    const target = current.workspaces.find(item => item.id === id)
    if (!target) throw new Error(`Agent 工作区不存在: ${id}`)
    if (target.storageMode !== 'managed' || target.slug === 'default' || target.rootPath !== undefined) throw new Error('仅允许级联删除非默认managed工作区')
    if (current.workspaces.length <= 1) throw new Error('至少需要保留一个项目')
    if (!target.slug || target.slug === '.' || target.slug === '..' || /[/\\:\u0000-\u001f]/.test(target.slug)) throw new Error('工作区目录路径异常')
    const root = resolve(workspaceRoot)
    const directory = resolve(root, target.slug)
    const inside = (parent: string, child: string): boolean => {
      const rel = relative(parent, child)
      return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
    }
    if (!inside(root, directory)) throw new Error('工作区目录路径异常')
    // lstat 同时识别悬空链接；不能用 existsSync 跳过失效的目录身份。
    const rootStats = lstatSync(root)
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Error('托管工作区根目录不安全')
    let stats
    try { stats = lstatSync(directory) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (stats && (stats.isSymbolicLink() || !stats.isDirectory())) throw new Error('工作区目录不安全')
    const canonicalRoot = realpathSync(root)
    const actual = stats ? realpathSync(directory) : resolve(canonicalRoot, target.slug)
    if (!inside(canonicalRoot, actual)) throw new Error('工作区目录身份越界，拒绝删除')
    for (const item of current.workspaces) {
      if (!item.rootPath || !isAbsolute(item.rootPath)) continue
      const projectRoot = existsSync(item.rootPath) ? realpathSync(item.rootPath) : resolve(item.rootPath)
      if (actual === projectRoot || inside(actual, projectRoot) || inside(projectRoot, actual)) throw new Error('工作区目录与项目根重叠，拒绝删除')
    }
    return target
  }
  const removeManagedAfterCascade = (id: string): void => {
    const target = assertManagedDeleteTarget(id)
    const index = read()
    index.workspaces = index.workspaces.filter(item => item.id !== target.id)
    write(index)
  }
  const remove = (id: string): void => {
    const target = assertRemovable(id)
    const index = read()
    // 只删绑定；managed 目录也保留，不递归清理用户资产。
    index.workspaces = index.workspaces.filter(item => item.id !== target.id)
    write(index)
  }
  return {
    list,
    update,
    reorder,
    assertRemovable,
    assertManagedDeleteTarget,
    removeManagedAfterCascade,
    remove,
    createManaged(name) {
      const normalizedName = name.trim()
      if (!normalizedName || normalizedName.length > 80) throw new Error('工作区名称不能为空且不能超过 80 个字符')
      const index = read()
      if (index.workspaces.some(item => item.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) throw new Error(`工作区名称「${normalizedName}」已存在`)
      const slug = slugify(normalizedName, new Set(index.workspaces.map(item => item.slug)))
      mkdirSync(workspaceRoot, { recursive: true })
      const directory = join(workspaceRoot, slug)
      mkdirSync(directory)
      try { return create(normalizedName, 'managed') }
      catch (error) {
        try { rmdirSync(directory) } catch { /* Never remove a non-empty path created concurrently. */ }
        throw error
      }
    },
    relocateProject({ id, rootPath }) {
      const index = read()
      const target = index.workspaces.find(item => item.id === id)
      if (!target) throw new Error('项目工作区不存在')
      if (target.storageMode !== 'project' && !(target.rootPath && isAbsolute(target.rootPath))) throw new Error('不是项目模式工作区，不能重新定位')
      if (typeof rootPath !== 'string' || !isAbsolute(rootPath) || rootPath.includes('\0')) throw new Error('项目路径必须是有效绝对路径')
      if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) throw new Error('目标项目目录不存在或不是目录')
      const canonicalRoot = realpathSync(rootPath)
      if (index.workspaces.some(item => item.id !== id && (
        (item.rootPath && existsSync(item.rootPath) && realpathSync(item.rootPath) === canonicalRoot)
        || (existsSync(join(workspaceRoot, item.slug)) && realpathSync(join(workspaceRoot, item.slug)) === canonicalRoot)))) throw new Error('目标项目目录已绑定其他工作区')
      beforeRelocate?.(target)
      const configDirectory = join(canonicalRoot, '.profer')
      assertProjectPathSafe(canonicalRoot, configDirectory)
      if (existsSync(configDirectory) && !statSync(configDirectory).isDirectory()) throw new Error('目标项目 .profer 不是目录')
      assertProjectRelocationHistory(target, canonicalRoot, listSessions?.() ?? [])
      const updated = { ...target, storageMode: 'project' as const, rootPath: canonicalRoot, updatedAt: Date.now() }
      index.workspaces = index.workspaces.map(item => item.id === id ? updated : item)
      write(index)
      return { workspace: updated, created: false, warnings: [] }
    },
    bindProject({ rootPath, name, open = false }) {
      if (!isAbsolute(rootPath) || rootPath.includes('\0')) throw new Error('Linux 项目路径必须是有效绝对路径')
      let stats
      try { stats = statSync(rootPath) } catch { throw new Error(`Linux 项目目录不存在：${rootPath}`) }
      if (!stats.isDirectory()) throw new Error(`Linux 项目路径不是目录：${rootPath}`)
      const normalizedPath = realpathSync(rootPath)
      if (desktopIndexWritable) {
        const globalRoot = existsSync(configDir) ? realpathSync(configDir) : resolve(configDir)
        const inside = (parent: string, child: string) => { const path = relative(parent, child); return !path || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path) }
        if (!relative(normalizedPath, resolve(normalizedPath, '..')) || inside(globalRoot, normalizedPath) || inside(normalizedPath, globalRoot)) throw new Error('项目路径不能是文件系统根或Profer配置目录及其父子目录')
      }
      const existing = read().workspaces.find(item => item.storageMode === 'project' && item.rootPath
        && (existsSync(item.rootPath) ? realpathSync(item.rootPath) : resolve(item.rootPath)) === normalizedPath)
      if (existing) {
        if (!open) throw new Error(`该 Linux 项目目录已绑定为「${existing.name}」`)
        prepareProjectSkeleton(normalizedPath, existing.name)
        return { workspace: existing, created: false, warnings: [] }
      }
      const resolvedName = name?.trim() || basename(normalizedPath) || 'Linux 项目'
      const configDirectory = join(normalizedPath, '.profer')
      assertProjectPathSafe(normalizedPath, configDirectory)
      if (existsSync(configDirectory) && (lstatSync(configDirectory).isSymbolicLink() || !lstatSync(configDirectory).isDirectory())) throw new Error('项目 .profer 路径不安全')
      const createdPaths = prepareProjectSkeleton(normalizedPath, resolvedName)
      try {
        const workspace = create(resolvedName, 'project', normalizedPath)
        return { workspace, created: true, warnings: [] }
      } catch (error) { rollbackCreatedPaths(createdPaths); throw error }
    },
  }
}

export function isValidLinuxWorkspacePath(value: string): boolean {
  return value.startsWith('/') && !value.includes('\0')
}
