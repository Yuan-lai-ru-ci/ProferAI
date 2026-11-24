import { globalConfig, preset as validatePreset } from './resource-preset-validation'
import { assertResourcePath } from './resource-paths'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import {
  AgentPresetError, BUILTIN_AGENT_PRESETS, DEFAULT_PRESET_ID, createEffectiveAgentPresetPolicy,
  resolveAgentPresetReference,
} from '@profer/shared'
import type { AgentPreset, AgentPresetConfig, AgentSessionMeta, AgentWorkspace, GlobalAgentPresetConfig } from '@profer/shared'
import type { CoreConfig } from './config'

function readObject(path: string): Record<string, unknown> | undefined {
  assertResourcePath(path)
  if (!existsSync(path)) return undefined
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Core资源配置格式错误：${path}`)
  return parsed as Record<string, unknown>
}

/** 只读Core资源边界；不迁移、不创建资源，不读取桌面或另一Core的全局目录。 */
export function corePresetStore(config: CoreConfig, workspace: AgentWorkspace | undefined) {
  if(workspace?.storageMode==='project' && (!workspace.rootPath || !isAbsolute(workspace.rootPath))) throw new Error('Core项目根必须为绝对路径')
  const configDir = workspace?.storageMode === 'project' && workspace.rootPath ? join(workspace.rootPath, '.profer')
    : workspace ? join(config.workspaceRoot, workspace.slug) : undefined
  const readWorkspace = (slug: string): AgentPresetConfig => {
    if (!workspace || slug !== workspace.slug || !configDir) throw new Error('预设引用不属于当前Core工作区')
    assertResourcePath(configDir)
    const directory = join(configDir, 'presets')
    const directoryConfig = readObject(join(directory, '_config.json'))
    const legacy = directoryConfig ?? readObject(join(configDir, 'agent-presets.json')) ?? {}
    if(legacy.version!==undefined && legacy.version!==1) throw new Error('Core不支持预设未来version')
    let presets: AgentPreset[]
    if (directoryConfig) {
      if (directoryConfig.schema !== 'profer.presets/1') throw new Error('Core不支持此预设目录schema')
      presets = readdirSync(directory).filter(file => file.endsWith('.json') && file !== '_config.json').sort().map(file => {
        const record = readObject(join(directory, file))!
        if (record.schema !== 'profer.preset/1') throw new Error('Core不支持此预设文件schema')
        const preset = (record.preset ?? record) as AgentPreset
        if (!preset.id || `${preset.id}.json` !== file) throw new Error('Core预设文件名与身份不一致')
        return preset
      })
    } else {
      if (legacy.presets !== undefined && !Array.isArray(legacy.presets)) throw new Error('Core预设列表格式错误')
      presets = (legacy.presets ?? []) as AgentPreset[]
    }
    presets = presets.map(validatePreset)
    if (presets.some(preset => !preset || typeof preset.id !== 'string' || typeof preset.name !== 'string')) throw new Error('Core预设条目无效')
    const disabled = legacy.disabledWorkspacePresetIds as string[] | undefined
    return { ...legacy, presets: presets.filter(preset => !disabled?.includes(preset.id)).map(preset => ({ ...preset, scope: 'workspace', workspaceSlug: slug })), defaultPresetId: String(legacy.defaultPresetId ?? DEFAULT_PRESET_ID) } as AgentPresetConfig
  }
  const readGlobal = (): GlobalAgentPresetConfig => {
    return globalConfig({ config })
  }
  return { readGlobal, readWorkspace, configDir }
}

export function resolveCorePreset(config: CoreConfig, session: AgentSessionMeta, workspace: AgentWorkspace | undefined) {
  if (session.workspaceId && !workspace) throw new Error('Core资源所属工作区不存在')
  const { readGlobal, readWorkspace, configDir } = corePresetStore(config, workspace)
  let reference = session.presetReference
  if (!reference && session.presetId) {
    const builtin = BUILTIN_AGENT_PRESETS.find(preset => preset.id === session.presetId)
    const local = workspace && readWorkspace(workspace.slug).presets.find(preset => preset.id === session.presetId)
    const global = readGlobal().presets.find(preset => preset.id === session.presetId)
    const selected = builtin ?? local ?? global
    if (!selected) throw new AgentPresetError('PRESET_NOT_FOUND', `Core预设不存在：${session.presetId}`)
    reference = { presetId: selected.id, presetScope: selected.scope ?? 'workspace', ...(selected.scope === 'workspace' ? { workspaceSlug: workspace!.slug } : {}) }
  }
  if (!reference && workspace) {
    const workspaceConfig = readWorkspace(workspace.slug)
    reference = workspaceConfig.defaultPresetReference
    if (!reference && workspaceConfig.defaultPresetExplicitlyCleared) throw new Error('Core工作区默认预设已显式清空；请先选择预设')
    if (!reference && workspaceConfig.defaultPresetId && workspaceConfig.defaultPresetId !== DEFAULT_PRESET_ID) throw new Error('Core工作区默认预设缺少严格作用域引用')
  }
  reference ??= { presetId: DEFAULT_PRESET_ID, presetScope: 'builtin-meta' }
  const preset = resolveAgentPresetReference(reference, workspace?.slug, { readGlobal, readWorkspace })
  const policy = createEffectiveAgentPresetPolicy(preset, reference, {
    permissionMode: session.permissionModeSource === 'user' ? undefined : session.permissionMode,
    userPermissionMode: session.permissionModeSource === 'user' ? session.permissionMode : undefined,
    runtimeSupportsSubagents: true,
  })
  return { preset, reference, policy, configDir }
}
