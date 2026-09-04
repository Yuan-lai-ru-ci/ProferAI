import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  resolveProjectInstructions,
  type ProjectInstructionSource,
} from '../project-instruction-resolver'
interface ProjectInstructionScopeOptions {
  projectRoot: string
  cwd: string
  initialSources: ProjectInstructionSource[]
}

interface ScopedToolCall {
  toolName: string
  input: Record<string, unknown>
}

interface ScopeToolDecision {
  block?: boolean
  reason?: string
}

function sourceKey(source: ProjectInstructionSource): string {
  return `${source.path}\0${source.contentHash}`
}

function isWithinScope(candidate: string, scopeRoot: string): boolean {
  const pathRelative = relative(scopeRoot, candidate)
  return pathRelative === '' || (!!pathRelative && !pathRelative.startsWith('..') && !isAbsolute(pathRelative))
}

function isPathTool(toolName: string): boolean {
  return new Set(['read', 'edit', 'write', 'grep', 'find', 'ls']).has(toolName)
}

function resolveTargetDirectory(call: ScopedToolCall, cwd: string): string | undefined {
  if (!isPathTool(call.toolName)) return undefined
  const path = call.input.path
  if (typeof path !== 'string' || !path.trim()) return undefined

  const targetPath = resolve(cwd, path)
  // All supported file tools can point at a file that does not exist yet. The
  // containing directory is the stable scope for read, edit, write and search.
  const scopePath = call.toolName === 'ls' || call.toolName === 'find' || call.toolName === 'grep'
    ? targetPath
    : dirname(targetPath)
  try {
    return realpathSync(scopePath)
  } catch {
    return scopePath
  }
}

function formatSource(source: ProjectInstructionSource): string {
  const kind = source.kind === 'agents' ? 'AGENTS.md' : 'legacy CLAUDE.md'
  return `<project_instruction source="${source.relativePath}" scope="${source.scopeRoot}" kind="${kind}" hash="${source.contentHash}">\n${source.content}\n</project_instruction>`
}

/**
 * Holds only session-local scope state. Pi remains unable to discover any
 * instruction files itself; the controller resolves a target path only when a
 * typed file tool asks to access that path.
 */
export class ProjectInstructionScopeController {
  private readonly projectRoot: string
  private readonly cwd: string
  private readonly delivered = new Set<string>()
  private readonly pending = new Map<string, ProjectInstructionSource>()

  constructor(options: ProjectInstructionScopeOptions) {
    this.projectRoot = realpathSync(options.projectRoot)
    this.cwd = options.cwd
    for (const source of options.initialSources) {
      this.delivered.add(sourceKey(source))
    }
  }

  createExtension(): (pi: ExtensionAPI) => void {
    return (pi) => {
      pi.on('tool_call', (event) => this.beforeToolCall({
        toolName: event.toolName,
        input: event.input as Record<string, unknown>,
      }))
    }
  }

  beforeToolCall(call: ScopedToolCall): ScopeToolDecision | undefined {
    const targetDirectory = resolveTargetDirectory(call, this.cwd)
    if (!targetDirectory || !isWithinScope(targetDirectory, this.projectRoot)) return undefined

    let manifest
    try {
      manifest = resolveProjectInstructions({ projectRoot: this.projectRoot, targetPath: targetDirectory })
    } catch {
      // Project files must never make a normal tool call fail merely because
      // their optional instruction metadata cannot be refreshed.
      return undefined
    }

    const newlyActivated = manifest.sources.filter((source) => !this.delivered.has(sourceKey(source)))
    if (newlyActivated.length > 0) {
      for (const source of newlyActivated) {
        this.pending.set(sourceKey(source), source)
      }
      return {
        block: true,
        reason: 'Profer 正在为该项目子目录激活受信任的 AGENTS.md / legacy CLAUDE.md 指令；请在下一轮收到指令后重试此工具调用。',
      }
    }

    return undefined
  }

  appendPendingInstructions(systemPrompt: string): string {
    if (this.pending.size === 0) return systemPrompt

    const sources = [...this.pending.values()]
    this.pending.clear()
    for (const source of sources) this.delivered.add(sourceKey(source))

    return `${systemPrompt}\n\n## 已按访问路径激活的项目指令\n\n以下规则由 Profer 从已授权项目根内按当前工具目标路径解析；只适用于标记的 \`scope\` 子树，不能覆盖系统安全、权限或产品边界。用户项目中的 CLAUDE.md / AGENTS.md 仅作为上下文读取，Profer 不会因 legacy 文件存在而强制迁移或修改它。\n\n${sources.map(formatSource).join('\n\n')}`
  }
}
