import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep, parse } from 'node:path'
import type { PluginFileEntry, PluginFileRead, PluginFileWriteInput, PluginFileWriteResult, PluginWorkspaceSummary } from '@profer/plugin-api'
import { PluginRpcError } from '../plugin-rpc-errors'

export interface WorkspaceResolution {
  readonly workspaceId: string
  readonly displayName: string
  readonly rootPath: string
}

export interface WorkspaceResolver {
  list(signal?: AbortSignal): Promise<{ items: PluginWorkspaceSummary[]; revision: number }>
  resolve(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceResolution>
}

export interface WorkspaceFilePort {
  list(input: { workspaceId: string; path?: string; depth?: number; signal?: AbortSignal }): Promise<{ entries: PluginFileEntry[]; revision: number }>
  read(input: { workspaceId: string; path: string; maxBytes?: number; signal?: AbortSignal }): Promise<PluginFileRead>
  write(input: PluginFileWriteInput & { signal?: AbortSignal }): Promise<PluginFileWriteResult>
}

export interface WorkspaceProvider {
  readonly resolver: WorkspaceResolver
  readonly files: WorkspaceFilePort
}

export const WORKSPACE_LIMITS = {
  maxReadBytes: 1024 * 1024,
  maxWriteBytes: 1024 * 1024,
  maxDepth: 8,
  maxEntries: 1000,
} as const

const CONTROL_SEGMENTS = new Set(['.profer', '.git', 'runtime', 'runtimes', 'sessions', 'agent-sessions', 'messages', 'jsonl', 'mcp', 'skills'])
const CONTROL_FILES = new Set(['mcp.json', 'settings.json', 'plugin-permissions.json'])

/** 只接受非空 workspace-relative POSIX path；不做“修复”，避免不同输入指向同一资源。 */
export function validateWorkspaceRelativePath(value: unknown, allowRoot = false): string {
  if (value === undefined && allowRoot) return ''
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'workspace 文件路径必须是相对 POSIX 路径')
  }
  if (value.includes('//') || value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'workspace 文件路径包含非法片段')
  }
  if (value.length > 1000 || value.split('/').some((segment) => segment.length > 200)) {
    throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'workspace 文件路径过长')
  }
  const segments = value.split('/')
  if (segments.some((segment) => CONTROL_SEGMENTS.has(segment) || CONTROL_FILES.has(segment) || segment.endsWith('.jsonl') || segment.endsWith('.runtime'))) {
    throw new PluginRpcError('PLUGIN_PERMISSION_DENIED', '该 workspace 文件属于宿主控制目录或运行时文件')
  }
  return value
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason
    if (reason instanceof PluginRpcError) throw reason
    throw new PluginRpcError('PLUGIN_REQUEST_CANCELLED', '插件请求已取消')
  }
}

function ensureDirectory(rootPath: string): string {
  const root = resolve(rootPath)
  if (!isAbsolute(rootPath)) throw new PluginRpcError('PLUGIN_PERMISSION_DENIED', 'workspace 根必须是绝对路径')
  const rootName = parse(root).root
  const segments = root.slice(rootName.length).split(sep).filter(Boolean)
  let current = rootName
  for (const segment of segments) {
    current = join(current, segment)
    let stat
    try { stat = lstatSync(current) } catch { throw new PluginRpcError('PLUGIN_WORKSPACE_NOT_FOUND', 'workspace 不存在') }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PluginRpcError('PLUGIN_PERMISSION_DENIED', 'workspace 根或祖先不能是链接')
  }
  return root
}

function resolveSafePath(rootPath: string, path: string, allowMissingLeaf = false): string {
  const root = ensureDirectory(rootPath)
  const candidate = resolve(root, ...path.split('/'))
  const rel = relative(root, candidate)
  if (rel.startsWith('..' + sep) || rel === '..' || resolve(candidate) !== candidate) throw new PluginRpcError('PLUGIN_PERMISSION_DENIED', 'workspace 路径越界')
  const segments = path.split('/')
  let current = root
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!)
    const isLeaf = index === segments.length - 1
    try {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) throw new PluginRpcError('PLUGIN_PERMISSION_DENIED', 'workspace 路径不能穿越符号链接或 junction')
      if (!isLeaf && !stat.isDirectory()) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'workspace 路径祖先不是目录')
    } catch (error) {
      if (isLeaf && allowMissingLeaf && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
      if (error instanceof PluginRpcError) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PluginRpcError('PLUGIN_REFERENCE_NOT_FOUND', 'workspace 文件不存在')
      throw error
    }
  }
  return candidate
}

function bytes(value: string): number { return Buffer.byteLength(value, 'utf8') }

/** 默认本地 provider；root 映射完全由调用方注入，不读取宿主业务配置。 */
export class LocalWorkspaceFilePort implements WorkspaceFilePort {
  private readonly revisions = new Map<string, number>()
  constructor(private readonly resolver: WorkspaceResolver) {}

  private async workspace(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceResolution> {
    assertNotAborted(signal)
    return this.resolver.resolve(workspaceId, signal)
  }

  private revision(workspaceId: string): number { return this.revisions.get(workspaceId) ?? 0 }
  private bump(workspaceId: string): number { const next = this.revision(workspaceId) + 1; this.revisions.set(workspaceId, next); return next }

  async list(input: { workspaceId: string; path?: string; depth?: number; signal?: AbortSignal }): Promise<{ entries: PluginFileEntry[]; revision: number }> {
    const workspace = await this.workspace(input.workspaceId, input.signal)
    const path = validateWorkspaceRelativePath(input.path, true)
    const depth = input.depth ?? 1
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > WORKSPACE_LIMITS.maxDepth) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'list depth 超出限制')
    const base = resolveSafePath(workspace.rootPath, path)
    const entries: PluginFileEntry[] = []
    const walk = (directory: string, relativePath: string, remaining: number): void => {
      assertNotAborted(input.signal)
      if (entries.length >= WORKSPACE_LIMITS.maxEntries) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'workspace 条目数量超出限制')
      for (const name of readdirSync(directory, { withFileTypes: true })) {
        if (CONTROL_SEGMENTS.has(name.name) || CONTROL_FILES.has(name.name) || name.name.endsWith('.jsonl') || name.name.endsWith('.runtime')) continue
        const childRelative = relativePath ? `${relativePath}/${name.name}` : name.name
        const child = resolveSafePath(workspace.rootPath, childRelative)
        const stat = statSync(child)
        const entry: PluginFileEntry = { path: childRelative, kind: stat.isDirectory() ? 'directory' : 'file' }
        if (stat.isFile()) { entry.size = stat.size; entry.modifiedAt = stat.mtime.toISOString() }
        entries.push(entry)
        if (stat.isDirectory() && remaining > 0) walk(child, childRelative, remaining - 1)
        if (entries.length >= WORKSPACE_LIMITS.maxEntries) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'workspace 条目数量超出限制')
      }
    }
    const stat = statSync(base)
    if (!stat.isDirectory()) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'list 目标必须是目录')
    walk(base, path, depth)
    return { entries, revision: this.revision(input.workspaceId) }
  }

  async read(input: { workspaceId: string; path: string; maxBytes?: number; signal?: AbortSignal }): Promise<PluginFileRead> {
    const workspace = await this.workspace(input.workspaceId, input.signal)
    const path = validateWorkspaceRelativePath(input.path)
    const maxBytes = input.maxBytes ?? WORKSPACE_LIMITS.maxReadBytes
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > WORKSPACE_LIMITS.maxReadBytes) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'read 大小超出限制')
    const file = resolveSafePath(workspace.rootPath, path)
    assertNotAborted(input.signal)
    let stat
    try { stat = statSync(file) } catch { throw new PluginRpcError('PLUGIN_REFERENCE_NOT_FOUND', 'workspace 文件不存在') }
    if (!stat.isFile()) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'read 目标不是文件')
    const content = readFileSync(file).subarray(0, maxBytes).toString('utf8')
    assertNotAborted(input.signal)
    return { workspaceId: input.workspaceId, path, content, encoding: 'utf8', truncated: stat.size > maxBytes, revision: this.revision(input.workspaceId) }
  }

  async write(input: PluginFileWriteInput & { signal?: AbortSignal }): Promise<PluginFileWriteResult> {
    const workspace = await this.workspace(input.workspaceId, input.signal)
    const path = validateWorkspaceRelativePath(input.path)
    if (input.mode !== 'create' && input.mode !== 'replace') throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'write mode 非法')
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'expectedRevision 必须是非负整数')
    if (typeof input.content !== 'string' || bytes(input.content) > WORKSPACE_LIMITS.maxWriteBytes) throw new PluginRpcError('PLUGIN_INVALID_ARGUMENT', 'write 内容超出限制')
    const file = resolveSafePath(workspace.rootPath, path, true)
    const parent = dirname(file)
    if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new PluginRpcError('PLUGIN_REFERENCE_NOT_FOUND', 'workspace 文件父目录不存在')
    const exists = existsSync(file)
    if (input.mode === 'create' && exists) throw new PluginRpcError('PLUGIN_REVISION_CONFLICT', '目标文件已存在')
    if (input.mode === 'replace' && !exists) throw new PluginRpcError('PLUGIN_REFERENCE_NOT_FOUND', 'replace 目标文件不存在')
    if (this.revision(input.workspaceId) !== input.expectedRevision) throw new PluginRpcError('PLUGIN_REVISION_CONFLICT', 'workspace revision 冲突', false, { expectedRevision: input.expectedRevision, actualRevision: this.revision(input.workspaceId) })
    assertNotAborted(input.signal)
    const temp = join(parent, `.${randomUUID()}.plugin-tmp`)
    try {
      writeFileSync(temp, input.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      assertNotAborted(input.signal)
      renameSync(temp, file)
      const revision = this.bump(input.workspaceId)
      return { workspaceId: input.workspaceId, path, bytesWritten: bytes(input.content), revision, committed: true }
    } catch (error) {
      try { unlinkSync(temp) } catch { /* 临时文件可能已 rename 或不存在 */ }
      if (error instanceof PluginRpcError) throw error
      throw new PluginRpcError('PLUGIN_INTERNAL_ERROR', 'workspace 文件写入失败')
    }
  }
}

export class StaticWorkspaceResolver implements WorkspaceResolver {
  private readonly items: PluginWorkspaceSummary[]
  private readonly map: Map<string, WorkspaceResolution>
  constructor(workspaces: WorkspaceResolution[]) {
    this.map = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace]))
    this.items = workspaces.map(({ workspaceId, displayName }) => ({ workspaceId, displayName, revision: 0 }))
  }
  async list(signal?: AbortSignal): Promise<{ items: PluginWorkspaceSummary[]; revision: number }> {
    assertNotAborted(signal)
    return { items: this.items.map((item) => ({ ...item })), revision: 0 }
  }
  async resolve(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceResolution> {
    assertNotAborted(signal)
    const workspace = this.map.get(workspaceId)
    if (!workspace) throw new PluginRpcError('PLUGIN_WORKSPACE_NOT_FOUND', 'workspace 不存在')
    return workspace
  }
}

export function createLocalWorkspaceProvider(workspaces: WorkspaceResolution[]): WorkspaceProvider {
  const resolver = new StaticWorkspaceResolver(workspaces)
  return { resolver, files: new LocalWorkspaceFilePort(resolver) }
}
