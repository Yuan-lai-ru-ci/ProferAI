import { lists, validateFields, preset, reference, globalConfig } from './resource-preset-validation'
import { assertSafeSkillSegment } from '@profer/agent-provider-pi/skills/skill-path-security'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, unlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUILTIN_AGENT_PRESETS, DEFAULT_PRESET_ID, normalizeAgentPresetReference, resolveAgentPresetReference, AGENT_PRESET_SUPPRESS_KEYS, AGENT_PRESET_TOOL_NAMES, AGENT_PRESET_CAPABILITY_GROUPS } from '@profer/shared'
import type { AgentPreset, AgentPresetConfig, GlobalAgentPresetConfig, PresetReference, PresetReferenceReport } from '@profer/shared'
import { atomicWriteFile, atomicWriteJson } from '../../../packages/session-store/src/atomic-write'
import { assertResourcePath, coreWorkspaceDirectory, readResourceObject, resourceObject, resourceText } from './resource-paths'
import type { CoreResourceOperationContext } from './resource-paths'

export function readCorePresetResources(context: CoreResourceOperationContext, slug: string) {
  const { directory } = coreWorkspaceDirectory(context, slug)
  const dir = join(directory, 'presets'), directoryConfig = readResourceObject(join(dir, '_config.json'))
  if (directoryConfig && directoryConfig.schema !== 'profer.presets/1') throw new Error('Core不支持预设目录schema')
  const raw = directoryConfig ?? readResourceObject(join(directory, 'agent-presets.json')) ?? { presets: [], defaultPresetId: DEFAULT_PRESET_ID }
  const values = directoryConfig ? readdirSync(dir).filter(name => name.endsWith('.json') && name !== '_config.json').sort().map(name => {
    const entry = readResourceObject(join(dir, name))!
    if (entry.schema !== 'profer.preset/1') throw new Error('Core预设schema错误')
    const result = preset(entry.preset ?? entry)
    if (`${result.id}.json` !== name) throw new Error('Core预设文件身份不一致')
    return result
  }) : raw.presets
  if (!Array.isArray(values)) throw new Error('Core预设列表损坏')
  for (const field of ['disabledGlobalPresetIds','disabledWorkspacePresetIds']) if (raw[field] !== undefined && (!Array.isArray(raw[field]) || raw[field].some(v => typeof v !== 'string'))) throw new Error('Core预设禁用列表损坏')
  if (raw.version !== undefined && raw.version !== 1) throw new Error('Core不支持预设未来version')
  const presets = values.map(value => ({ ...preset(value), scope: 'workspace' as const, workspaceSlug: slug }))
  const config = { ...raw, presets, defaultPresetId: typeof raw.defaultPresetId === 'string' ? raw.defaultPresetId : DEFAULT_PRESET_ID } as AgentPresetConfig
  const global = globalConfig(context)
  if (global.workspaceScopes !== undefined) for (const scopes of Object.values(resourceObject(global.workspaceScopes))) if (!Array.isArray(scopes) || scopes.some(value => typeof value !== 'string')) throw new Error('Core全局预设范围账本损坏')
  const store = { readGlobal: () => global, readWorkspace: (key: string) => {
    if (key !== slug) throw new Error('Core预设引用越过工作区')
    return { ...config, presets: config.presets.filter(item => !config.disabledWorkspacePresetIds?.includes(item.id)) }
  } }
  return { raw, config, global, store, directoryConfig, directory, dir }
}
export const CORE_PRESET_OPERATION_ARITY: Record<string, [number,number]> = {
  listAgentPresets: [0,2], listGlobalAgentPresets: [0,0], getDefaultPresetId: [0,1], setDefaultPresetId: [2,2], setDefaultPresetReference: [2,2],
  createAgentPreset: [2,2], copyAgentPreset: [2,3], updateAgentPreset: [3,3], deleteAgentPreset: [2,2], setWorkspacePresetEnabled: [3,3],
  getPresetReferenceReport: [1,1],
  copyPresetToWorkspace: [2,3], importPresetFromWorkspace: [3,3], promoteWorkspacePresetToGlobal: [3,4],
  enableGlobalPresetInWorkspace: [2,2], disableGlobalPresetInWorkspace: [2,2], getOtherWorkspacePresets: [1,1],
}
function referenceForId(config: AgentPresetConfig, id: string, slug: string): PresetReference {
  if (BUILTIN_AGENT_PRESETS.some(p => p.id === id)) return { presetId: id, presetScope: 'builtin-meta' }
  if (config.presets.some(p => p.id === id)) return { presetId: id, presetScope: 'workspace', workspaceSlug: slug }
  return { presetId: id, presetScope: 'user-global' }
}
function reportReferences(context: CoreResourceOperationContext, ref: PresetReference): PresetReferenceReport {
  if (!context.sessions || !context.automations) throw new Error('Core引用报告缺少审计服务')
  const global = globalConfig(context)
  const matches = (candidate: PresetReference) => candidate.presetId === ref.presetId && candidate.presetScope === ref.presetScope && candidate.workspaceSlug === ref.workspaceSlug
  const blockers: PresetReferenceReport['blockers'] = [], workspaceScopes: PresetReferenceReport['workspaceScopes'] = []
  for (const workspace of context.workspaces.list()) {
    const config = readCorePresetResources(context, workspace.slug).config
    const scopes = global.workspaceScopes?.[ref.presetId]
    const active = ref.presetScope !== 'workspace' && !config.disabledGlobalPresetIds?.includes(ref.presetId) && (!scopes || scopes.includes(workspace.slug))
    if (active) workspaceScopes.push({ workspaceSlug: workspace.slug, workspaceName: workspace.name })
    const add = (reason: 'workspace-default' | 'session' | 'automation' | 'other', ids: string[]) => {
      if (ids.length) blockers.push({ workspaceSlug: workspace.slug, workspaceName: workspace.name, status: active ? 'active' : 'inactive', reason, objectIds: ids, objectCount: ids.length, actions: ['inspect'] })
    }
    const defaultRef = config.defaultPresetReference ?? referenceForId(config, config.defaultPresetId, workspace.slug)
    add('workspace-default', matches(defaultRef) ? [workspace.slug] : [])
    for (const [reason, items] of [['session',context.sessions.list()],['automation',context.automations.list()]] as const) {
      add(reason, items.filter(item => item.workspaceId === workspace.id && matches(item.presetReference ?? referenceForId(config,item.presetId ?? '',workspace.slug))).map(item => item.id))
    }
    add('other',config.presets.filter(item => item.basePresetReference && matches(item.basePresetReference)).map(item => item.id))
  }
  return { preset: ref, blockers, workspaceScopes, totalCount: blockers.reduce((sum,item)=>sum+item.objectCount,0), canDelete: blockers.length === 0 && workspaceScopes.length === 0 && ref.presetScope !== 'builtin-meta' }
}
export async function executeCorePresetOperation(context: CoreResourceOperationContext, operation: string, args: unknown[]): Promise<unknown> {
  if (operation === 'getPresetReferenceReport') return reportReferences(context, reference(args[0]))
  if (operation === 'promoteWorkspacePresetToGlobal') {
    const slug = resourceText(args[0]), id = resourceText(args[1])
    const state = readCorePresetResources(context, slug)
    const source = state.config.presets.find(item => item.id === id)
    if (!source) throw new Error('Core工作区预设不存在')
    if (!Array.isArray(args[2]) || args[2].length > 512) throw new Error('Core预设目标工作区范围无效')
    const scopes = [...new Set(args[2].map(value => coreWorkspaceDirectory(context, value).workspace.slug))]
    const keep = args[3] ?? true
    if (typeof keep !== 'boolean') throw new Error('Core预设保留副本参数无效')
    const ref: PresetReference = { presetId: id, presetScope: 'workspace', workspaceSlug: slug }
    if (!keep && reportReferences(context, ref).blockers.length) throw new Error('Core预设仍被引用，请先解除引用')
    const defaultRef = state.config.defaultPresetReference ?? referenceForId(state.config, state.config.defaultPresetId, slug)
    if (keep && defaultRef.presetId === id && defaultRef.presetScope === 'workspace') throw new Error('Core不能禁用当前默认预设；请先更换默认预设引用')
    // 提升为独立全局实体，展开基座以免新实体依赖原工作区。
    const expanded = resolveAgentPresetReference(ref, slug, { ...state.store, readWorkspace: (key: string) => key === slug ? state.config : state.store.readWorkspace(key) })
    const result: AgentPreset = { ...expanded, id: randomUUID(), scope: 'user-global', isBuiltin: false, createdAt: Date.now(), updatedAt: Date.now() }
    delete result.workspaceSlug; delete result.basePresetId; delete result.basePresetReference
    const globalPath = join(context.config.configDir, 'agent-presets.json')
    const paths = [globalPath, ...(state.directoryConfig ? [join(state.dir, '_config.json'), join(state.dir, `${id}.json`)] : [join(state.directory, 'agent-presets.json')])]
    const before = paths.map(path => { assertResourcePath(path); return { path, content: existsSync(path) ? readFileSync(path, 'utf8') : undefined } })
    const global = state.global
    global.presets.push(result)
    global.workspaceScopes = { ...global.workspaceScopes, [result.id]: scopes }
    try {
      await atomicWriteJson(globalPath, global)
      await executeCorePresetOperation(context, keep ? 'setWorkspacePresetEnabled' : 'deleteAgentPreset', keep ? [slug, id, false] : [slug, id])
    } catch (error) {
      const failures: unknown[] = [error]
      for (const { path, content } of before) {
        try { if (content === undefined) { if (existsSync(path)) unlinkSync(path) } else await atomicWriteFile(path, content) }
        catch (restoreError) { failures.push(restoreError) }
      }
      if (failures.length > 1) throw new AggregateError(failures, 'Core预设提升及恢复失败')
      throw error
    }
    return result
  }
  if (args[0] == null && ['createAgentPreset','copyAgentPreset','updateAgentPreset','deleteAgentPreset'].includes(operation)) {
    const global = globalConfig(context)
    const id = operation === 'createAgentPreset' ? randomUUID() : resourceText(args[1])
    const existing = global.presets.find(item => item.id === id)
    if (operation === 'deleteAgentPreset') {
      if (!existing) throw new Error('Core全局预设不存在或内置只读')
      const report = reportReferences(context,{presetId:id,presetScope:'user-global'})
      if (!report.canDelete) throw new Error('Core全局预设仍被引用或工作区启用，请先显式解除')
      global.presets = global.presets.filter(item => item.id !== id)
      if (global.workspaceScopes) delete global.workspaceScopes[id]
      await atomicWriteJson(join(context.config.configDir,'agent-presets.json'),global); return
    }
    let input: Record<string,unknown>
    if (operation === 'createAgentPreset') input = resourceObject(args[1])
    else if (operation === 'copyAgentPreset') {
      const source = existing ?? BUILTIN_AGENT_PRESETS.find(item => item.id === id)
      if (!source) throw new Error('Core复制源不存在')
      const expanded = resolveAgentPresetReference({presetId:id,presetScope: existing ? 'user-global':'builtin-meta'},undefined,{readGlobal:()=>global,readWorkspace:()=>{throw new Error('Core全局复制不能读取工作区')}})
      input = {...expanded,name:args[2] == null ? `${expanded.name} 副本`:resourceText(args[2],512)}
      delete input.basePresetId; delete input.basePresetReference
    } else {
      if (!existing) throw new Error('Core全局预设不存在或内置只读')
      const patch = resourceObject(args[2])
      const expanded = patch.basePresetId === null
        ? resolveAgentPresetReference({ presetId: id, presetScope: 'user-global' }, undefined, {
          readGlobal: () => global,
          readWorkspace: () => { throw new Error('Core全局基座不能读取工作区') },
        })
        : existing
      input = { ...expanded }
      if (patch.basePresetId === null) delete input.basePresetReference
      for (const [field, value] of Object.entries(patch)) {
        if (value === null) delete input[field]
        else input[field] = value
      }
    }
    if (operation !== 'copyAgentPreset') {
      const supplied = resourceObject(operation === 'createAgentPreset' ? args[1] : args[2])
      const allowed = new Set([...lists,'name','description','channelId','modelId','effort','permissionMode','allowSubagents','basePresetId'])
      for (const key of Object.keys(supplied)) if (!allowed.has(key)) throw new Error(`Core全局预设字段不支持：${key}`)
    }
    validateFields(input)
    if (typeof input.name !== 'string' || typeof input.description !== 'string') throw new Error('Core预设缺少名称/描述')
    const result = preset({...input,id:operation==='updateAgentPreset'?id:randomUUID(),name:input.name,description:input.description,scope:'user-global',isBuiltin:false,createdAt:existing?.createdAt??Date.now(),updatedAt:Date.now()})
    delete result.workspaceSlug
    global.presets = operation==='updateAgentPreset'?global.presets.map(item=>item.id===id?result:item):[...global.presets,result]
    resolveAgentPresetReference({presetId:result.id,presetScope:'user-global'},undefined,{readGlobal:()=>global,readWorkspace:()=>{throw new Error('Core全局基座不能读取工作区')}})
    await atomicWriteJson(join(context.config.configDir,'agent-presets.json'),global); return result
  }
  if (operation === 'copyPresetToWorkspace' || operation === 'importPresetFromWorkspace') {
    const target = resourceText(operation === 'copyPresetToWorkspace' ? args[1] : args[0])
    const sourceRef = operation === 'copyPresetToWorkspace' ? reference(args[0]) : { presetId: resourceText(args[2]), presetScope: 'workspace' as const, workspaceSlug: resourceText(args[1]) }
    const sourceSlug = sourceRef.workspaceSlug ?? target
    const source = readCorePresetResources(context, sourceSlug)
    const expanded = resolveAgentPresetReference(sourceRef, sourceSlug, source.store)
    const input: Record<string, unknown> = { name: operation === 'copyPresetToWorkspace' && args[2] != null ? resourceText(args[2],512) : expanded.name, description: expanded.description }
    for (const key of [...lists,'channelId','modelId','effort','permissionMode','allowSubagents']) if (expanded[key as keyof AgentPreset] !== undefined) input[key] = expanded[key as keyof AgentPreset]
    return executeCorePresetOperation(context, 'createAgentPreset', [target,input])
  }
  if (operation === 'listAgentPresets' && args[1] !== undefined && typeof args[1] !== 'boolean') throw new Error('Core预设includeInactiveGlobal无效')
  if (operation === 'listGlobalAgentPresets'  || ((operation === 'listAgentPresets' || operation === 'getDefaultPresetId') && args[0] == null)) {
    if (operation === 'getDefaultPresetId') return DEFAULT_PRESET_ID
    const global = globalConfig(context)
    return [...BUILTIN_AGENT_PRESETS, ...global.presets]
  }
  const slug = resourceText(args[0]); const state = readCorePresetResources(context, slug)
  const { config, global, store } = state
  const refFor = (id: string): PresetReference => ({ presetId: id, presetScope: BUILTIN_AGENT_PRESETS.some(p => p.id === id) ? 'builtin-meta' : config.presets.some(p => p.id === id) ? 'workspace' : 'user-global', ...(config.presets.some(p => p.id === id) ? { workspaceSlug: slug } : {}) })
  const resolve = (ref: PresetReference) => resolveAgentPresetReference(ref, slug, store)
  const save = async (changed?: AgentPreset, deleted?: string) => {
    if (state.directoryConfig) {
      if (changed) { const path = join(state.dir, `${changed.id}.json`); assertResourcePath(path); const prior = readResourceObject(path) ?? {}; await atomicWriteJson(path, { ...prior, schema: 'profer.preset/1', preset: changed }) }
      if (deleted) { const path = join(state.dir, `${deleted}.json`); assertResourcePath(path); if (existsSync(path)) unlinkSync(path) }
      const { presets: _presets, ...metadata } = config
      await atomicWriteJson(join(state.dir, '_config.json'), { ...state.raw, ...metadata })
    } else await atomicWriteJson(join(state.directory, 'agent-presets.json'), config)
  }
  if (operation === 'listAgentPresets') {
    if (args[1] !== undefined && typeof args[1] !== 'boolean') throw new Error('Core预设includeInactiveGlobal无效')
    const candidates = [...BUILTIN_AGENT_PRESETS, ...global.presets.filter(p => args[1] || (global.workspaceScopes?.[p.id] === undefined || global.workspaceScopes[p.id]!.includes(slug))), ...config.presets]
    return candidates.map(item => {
      const ref = referenceForId(config,item.id,slug)
      const expanded = resolveAgentPresetReference(ref, undefined, { readGlobal:()=>global,readWorkspace:()=>config })
      const enabled = ref.presetScope === 'workspace' ? !config.disabledWorkspacePresetIds?.includes(item.id) : !config.disabledGlobalPresetIds?.includes(item.id) && (global.workspaceScopes?.[item.id] === undefined || global.workspaceScopes[item.id]!.includes(slug))
      return {...expanded,scope:ref.presetScope,enabledInWorkspace:enabled}
    })
  }
  if (operation === 'getOtherWorkspacePresets') return context.workspaces.list().filter(w => w.slug !== slug).map(w => ({ workspaceName: w.name, workspaceSlug: w.slug, presets: readCorePresetResources(context, w.slug).config.presets }))
  if (operation === 'getDefaultPresetId') { if (config.defaultPresetId) resolve(config.defaultPresetReference ?? refFor(config.defaultPresetId)); return config.defaultPresetReference?.presetId ?? config.defaultPresetId }
  if (operation === 'setDefaultPresetId' || operation === 'setDefaultPresetReference') {
    if (operation === 'setDefaultPresetId' && resourceText(args[1]).trim() === '') { config.defaultPresetId = ''; config.defaultPresetExplicitlyCleared = true; delete config.defaultPresetReference; await save(); return '' }
    const ref = operation === 'setDefaultPresetId' ? refFor(resourceText(args[1])) : reference(args[1], slug)
    resolve(ref); config.defaultPresetReference = ref; config.defaultPresetId = ref.presetId; config.defaultPresetExplicitlyCleared = false
    await save(); return operation === 'setDefaultPresetId' ? ref.presetId : ref
  }
  if (operation === 'setWorkspacePresetEnabled' || operation === 'enableGlobalPresetInWorkspace' || operation === 'disableGlobalPresetInWorkspace') {
    const local = operation === 'setWorkspacePresetEnabled'
    const suppliedReference = local ? undefined : reference(args[1])
    if (suppliedReference?.presetScope === 'workspace') throw new Error('Core全局开关不得接受工作区引用')
    const id = suppliedReference?.presetId ?? resourceText(args[1])
    if (local && typeof args[2] !== 'boolean') throw new Error('Core预设enabled无效')
    if (suppliedReference && (suppliedReference.presetScope === 'builtin-meta' ? !BUILTIN_AGENT_PRESETS.some(p => p.id === id) : !global.presets.some(p => p.id === id))) throw new Error('Core预设引用scope与ID不匹配')
    if (!(local ? config.presets : [...BUILTIN_AGENT_PRESETS, ...global.presets]).some(p => p.id === id)) throw new Error('Core预设不存在')
    const enabled = local ? args[2] : operation === 'enableGlobalPresetInWorkspace'
    const key = local ? 'disabledWorkspacePresetIds' : 'disabledGlobalPresetIds'
    config[key] = [...new Set([...(config[key] ?? []).filter(value => value !== id), ...(enabled ? [] : [id])])]
    if (!enabled && (config.defaultPresetReference ?? refFor(config.defaultPresetId)).presetId === id && (config.defaultPresetReference ?? refFor(config.defaultPresetId)).presetScope === (local ? 'workspace' : suppliedReference!.presetScope)) throw new Error('Core不能禁用当前默认预设；请先更换默认预设')
    // 全局范围账本必须与运行时同一份。
    if (!local) {
      const scopes = global.workspaceScopes ?? {}; global.workspaceScopes = { ...scopes, [id]: [...new Set([...(scopes[id] ?? context.workspaces.list().map(w=>w.slug)).filter(s => s !== slug), ...(enabled ? [slug] : [])])] }
      await atomicWriteJson(join(context.config.configDir, 'agent-presets.json'), global)
    }
    await save(); return
  }
  const id = operation === 'createAgentPreset' ? randomUUID() : resourceText(args[1])
  const existing = config.presets.find(p => p.id === id)
  if (operation === 'deleteAgentPreset') {
    if (!existing) throw new Error('Core工作区预设不存在或为只读全局预设')
    if (!context.sessions || !context.automations) throw new Error('Core预设删除缺少引用审计服务')
    const matches = (ref: PresetReference | undefined, legacyId?: string, workspaceId?: string) => ref
      ? ref.presetScope === 'workspace' && ref.presetId === id && ref.workspaceSlug === slug
      : legacyId === id && workspaceId === context.workspaces.list().find(w => w.slug === slug)?.id
    const blockers: string[] = []
    for (const workspace of context.workspaces.list()) {
      const other = readCorePresetResources(context,workspace.slug).config
      if (matches(other.defaultPresetReference,other.defaultPresetId,workspace.id)) blockers.push(`默认:${workspace.slug}`)
      for (const child of other.presets) if (matches(child.basePresetReference)) blockers.push(`基座:${workspace.slug}/${child.id}`)
    }
    for (const item of context.sessions.list()) if (matches(item.presetReference,item.presetId,item.workspaceId)) blockers.push(`会话:${item.id}`)
    for (const item of context.automations.list()) if (matches(item.presetReference,item.presetId,item.workspaceId)) blockers.push(`自动化:${item.id}`)
    if (blockers.length) throw new Error(`Core预设仍被引用：${blockers.join('，')}`)
    config.presets = config.presets.filter(p => p.id !== id)
    config.disabledWorkspacePresetIds = config.disabledWorkspacePresetIds?.filter(value => value !== id)
    await save(undefined,id); return
  }
  let result: AgentPreset
  if (operation === 'createAgentPreset' || operation === 'copyAgentPreset') {
    const input = operation === 'copyAgentPreset' ? { ...resolve(refFor(id)), name: args[2] === undefined ? `${resolve(refFor(id)).name} 副本` : resourceText(args[2], 512) } : resourceObject(args[1])
    validateFields(input)
    if (operation === 'createAgentPreset') for (const key of Object.keys(input)) if (![...lists, 'name','description','channelId','modelId','effort','permissionMode','allowSubagents','basePresetId'].includes(key)) throw new Error(`Core创建预设字段不支持：${key}`)
    if (typeof input.name !== 'string' || typeof input.description !== 'string') throw new Error('Core创建预设缺少名称/描述')
    result = { ...input, id: randomUUID(), scope: 'workspace', workspaceSlug: slug, name: input.name, description: input.description, isBuiltin: false, createdAt: Date.now(), updatedAt: Date.now() }
    if (operation === 'copyAgentPreset') { delete result.basePresetId; delete result.basePresetReference; delete result.sourcePresetId; result.sourcePresetId = id }
    config.presets.push(result)
  } else {
    if (!existing) throw new Error('Core工作区预设不存在或为只读全局预设')
    const patch = resourceObject(args[2]); const merged: Record<string, unknown> = { ...(patch.basePresetId === null ? resolve(refFor(id)) : existing) }
    if (patch.basePresetId === null) delete merged.basePresetReference
    const allowed = new Set([...lists, 'name','description','channelId','modelId','effort','permissionMode','allowSubagents','basePresetId'])
    for (const [key,value] of Object.entries(patch)) {
      if (!allowed.has(key)) throw new Error(`Core预设更新字段不支持：${key}`)
      if (value === null) { delete merged[key] } else merged[key] = value
    }
    validateFields(merged); result = preset({ ...merged, updatedAt: Date.now() }); config.presets = config.presets.map(p => p.id === id ? result : p)
  }
  resolve({ presetId: result.id, presetScope: 'workspace', workspaceSlug: slug })
  await save(result); return result
}
