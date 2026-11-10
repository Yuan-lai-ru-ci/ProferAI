/**
 * runtime 有效策略快照：来源、冻结、传递与最终消费点的行为测试。
 *
 * 覆盖（对应交付清单第 7 条）：
 * - 权限模式来源：策略默认值 / 显式覆盖 / 缺失策略（不猜默认值、不放行）；
 * - 一轮运行只解析一次，异步加载期间配置变化不影响本轮，下一轮读到新配置；
 * - 预设禁用（工具组 / allowSubagents / PPT 门禁）真的作用到最终注册的工具与资源；
 * - skill / MCP 白名单裁剪作用到最终交给 provider 的集合。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRuntimeQuery } from '@profer/agent-runtime'
import {
  AGENT_PRESET_CAPABILITY_GROUPS,
  PROFER_DEFAULT_PERMISSION_MODE,
  type AgentPreset,
  type PresetReference,
} from '@profer/shared'
import {
  AGENT_RUNTIME_POLICY_SNAPSHOT_KEY,
  AgentRuntimePolicySnapshotMissingError,
  agentRuntimePolicyRuns,
  attachAgentRuntimePolicyToQuery,
  buildPolicyToolAssemblyContext,
  collectPolicyDisallowedTools,
  createAgentRuntimePolicyRunRegistry,
  filterPolicyMcpResources,
  filterPolicySkills,
  readAgentRuntimePolicySnapshot,
  requireAgentRuntimePolicySnapshot,
  resolveAgentRuntimePolicySnapshot,
  resolveProviderPermissionMode,
  withPolicyLoadedMcpServers,
} from './agent-runtime-policy-snapshot'
import { createElectronProviderQueryPreparation } from './agent-runtime-provider-preparation'
import { createElectronAgentRuntimeQuery, getAgentRuntimeRunFacts, setAgentRuntimeRunFacts, clearAgentRuntimeRunFacts } from './agent-runtime-host'
import { createRuntimeEntryQuery } from './agent-runtime-entry'
import { buildPiBuiltinTools } from './adapters/pi-builtin-tools'
import { prepareAgentSkillRouting, buildSkillRuntimeOptions } from './skill-runtime-routing'

const reference: PresetReference = { presetId: 'preset-policy', presetScope: 'user-global' }

function preset(overrides: Partial<AgentPreset> = {}): AgentPreset {
  return {
    id: 'preset-policy',
    name: '策略测试预设',
    description: '',
    isBuiltin: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function queryFor(sessionId: string, providerInput?: Record<string, unknown>) {
  return createElectronAgentRuntimeQuery(
    { sessionId, channelId: 'policy-channel', userMessage: 'hello', agentRuntime: 'pi' } as never,
    {
      runtime: 'pi',
      cwd: '/tmp/policy-cwd',
      ...(providerInput ? { providerInput } : {}),
      toolAssemblyContext: { sessionId, channelId: 'policy-channel' },
    },
  )
}

async function prepareProviderOptions(query: AgentRuntimeQuery) {
  const preparation = createElectronProviderQueryPreparation()
  return await preparation.prepare(
    query,
    { credentials: { apiKey: 'policy-key', baseUrl: undefined, provider: 'custom', forceBearerAuth: false } },
    new AbortController().signal,
  ) as unknown as Record<string, unknown>
}

const toolNames = (result: { tools: readonly unknown[] }): string[] =>
  result.tools.map(tool => (tool as { name?: string }).name ?? '').filter(Boolean)

const skillRoots: string[] = []
afterEach(() => {
  for (const root of skillRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 在临时目录落出真实 Skill 目录，用于验证「策略裁剪 → 最终注册的 skill」链路。 */
function createSkillProjection(slugs: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), 'policy-skills-'))
  skillRoots.push(root)
  const skills = slugs.map(slug => {
    const path = join(root, 'skills', slug)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'SKILL.md'), `---\nname: ${slug}\ndescription: policy fixture skill\n---\nSECRET_${slug}\n`)
    return { slug, name: slug, path, version: '1', scope: 'workspace' as const, actualSource: 'workspace' as const }
  })
  return { path: root, skills, diagnostics: [] }
}

describe('权限模式来源', () => {
  test('Given 预设未声明权限模式 When 解析快照 Then 取共享默认值而不是 provider preparation 的猜测', () => {
    const snapshot = resolveAgentRuntimePolicySnapshot({ preset: preset(), presetReference: reference })
    expect(snapshot.policy.permissionMode).toBe(PROFER_DEFAULT_PERMISSION_MODE)
    expect(snapshot.policy.permissionMode).toBe('bypassPermissions')
  })

  test('Given 预设声明 auto When 请求 bypassPermissions 覆盖 Then 只能保持或收紧，不放宽', () => {
    const snapshot = resolveAgentRuntimePolicySnapshot({
      preset: preset({ permissionMode: 'auto' }),
      presetReference: reference,
      permissionModeOverride: 'bypassPermissions',
    })
    expect(snapshot.policy.permissionMode).toBe('auto')
  })

  test('Given 显式 plan 覆盖 When 解析快照 Then 收敛为 plan', () => {
    const snapshot = resolveAgentRuntimePolicySnapshot({
      preset: preset(),
      presetReference: reference,
      permissionModeOverride: 'plan',
    })
    expect(snapshot.policy.permissionMode).toBe('plan')
  })

  test('Given 缺少策略快照 When 读取或校验 Then 明确失败且不提供任何默认放行值', () => {
    expect(readAgentRuntimePolicySnapshot(undefined)).toBeUndefined()
    expect(readAgentRuntimePolicySnapshot({ permissionMode: 'bypassPermissions' })).toBeUndefined()
    expect(readAgentRuntimePolicySnapshot({ agentRuntimePolicySnapshot: { version: 99 } })).toBeUndefined()
    expect(() => requireAgentRuntimePolicySnapshot({})).toThrow(AgentRuntimePolicySnapshotMissingError)
    // 非法/缺失的 permissionMode 一律视为未提供：既不猜 auto，也不回落 bypassPermissions。
    expect(resolveProviderPermissionMode(undefined)).toBeUndefined()
    expect(resolveProviderPermissionMode({ permissionMode: 'yolo' })).toBeUndefined()
  })

  test('Given 未挂载策略的 query When provider preparation Then 不注入权限模式（不猜默认值、不放行）', async () => {
    const options = await prepareProviderOptions(queryFor('policy-unwired'))
    expect(options.permissionMode).toBeUndefined()
    expect(options.sdkPermissionMode).toBeUndefined()
    expect(options.allowDangerouslySkipPermissions).toBeUndefined()
  })

  test('本轮 run 构造后权限 facts 与冻结策略一致，不被原始 bypass 请求覆盖', () => {
    const sessionId = 'policy-effective-auto-entry'
    agentRuntimePolicyRuns.releaseRun(sessionId)
    clearAgentRuntimeRunFacts(sessionId)
    setAgentRuntimeRunFacts(sessionId, { triggeredBy: 'user', userMessage: 'fixture' })

    try {
      const built = createRuntimeEntryQuery({
        sessionId,
        userMessage: 'fixture',
        permissionModeOverride: 'bypassPermissions',
        channelId: 'policy-channel',
        agentRuntime: 'claude',
      } as never, {
        runtime: 'claude',
        policy: {
          preset: preset({ permissionMode: 'auto' }),
          presetReference: reference,
        },
        toolAssemblyContext: { sessionId },
      })

      expect(built.snapshot?.policy.permissionMode).toBe('auto')
      expect(getAgentRuntimeRunFacts(sessionId)?.permissionModeOverride).toBe('auto')
      expect(resolveProviderPermissionMode(built.query.providerInput)).toBe('auto')
    } finally {
      clearAgentRuntimeRunFacts(sessionId)
      agentRuntimePolicyRuns.releaseRun(sessionId)
    }
  })

  test('Given 仅显式合法覆盖 When provider preparation Then 透传该覆盖', async () => {
    const claudeOptions = await prepareProviderOptions(
      createElectronAgentRuntimeQuery(
        { sessionId: 'policy-explicit', channelId: 'policy-channel', userMessage: 'hello', agentRuntime: 'claude', permissionModeOverride: 'plan' } as never,
        { runtime: 'claude', cwd: '/tmp/policy-cwd' },
      ),
    )
    expect(claudeOptions.sdkPermissionMode).toBe('plan')
    expect(claudeOptions.allowDangerouslySkipPermissions).toBe(false)

    const piOptions = await prepareProviderOptions(queryFor('policy-explicit-pi', { permissionMode: 'auto' }))
    expect(piOptions.permissionMode).toBe('auto')
  })

  test('Given 挂载策略快照 When provider preparation Then 两套 runtime 都使用策略值', async () => {
    const snapshot = resolveAgentRuntimePolicySnapshot({ preset: preset(), presetReference: reference })
    const claudeQuery = attachAgentRuntimePolicyToQuery(
      createElectronAgentRuntimeQuery(
        { sessionId: 'policy-wired', channelId: 'policy-channel', userMessage: 'hello', agentRuntime: 'claude' } as never,
        { runtime: 'claude', cwd: '/tmp/policy-cwd' },
      ),
      snapshot,
    )
    const claudeOptions = await prepareProviderOptions(claudeQuery)
    expect(claudeOptions.sdkPermissionMode).toBe('bypassPermissions')
    expect(claudeOptions.allowDangerouslySkipPermissions).toBe(true)

    const planSnapshot = resolveAgentRuntimePolicySnapshot({
      preset: preset(),
      presetReference: reference,
      permissionModeOverride: 'plan',
    })
    const piQuery = attachAgentRuntimePolicyToQuery(queryFor('policy-wired-pi'), planSnapshot)
    const piOptions = await prepareProviderOptions(piQuery)
    expect(piOptions.permissionMode).toBe('plan')
    // 快照本身随 query 一起传递，后续消费点（工具装配 / MCP / skill / 权限）读同一份。
    expect(readAgentRuntimePolicySnapshot(piQuery.providerInput)).toBe(planSnapshot)
    // 但快照不进入 provider options：provider 边界只保留它自己能理解的字段。
    expect(piOptions).not.toHaveProperty(AGENT_RUNTIME_POLICY_SNAPSHOT_KEY)
    expect(claudeOptions).not.toHaveProperty(AGENT_RUNTIME_POLICY_SNAPSHOT_KEY)
  })

  test('Given 挂载快照 When 合并 providerInput Then 保留宿主原有字段', () => {
    const snapshot = resolveAgentRuntimePolicySnapshot({ preset: preset(), presetReference: reference })
    const query = createElectronAgentRuntimeQuery(
      { sessionId: 'policy-merge', channelId: 'policy-channel', userMessage: 'hello', agentRuntime: 'pi', mentionedSkills: ['pdf'] } as never,
      { runtime: 'pi', providerInput: { customMcpServers: { alpha: {} } } },
    )
    const merged = attachAgentRuntimePolicyToQuery(query, snapshot)
    expect(merged.providerInput?.customMcpServers).toEqual({ alpha: {} })
    expect(merged.providerInput?.mentionedSkills).toEqual(['pdf'])
    expect(merged.providerInput?.permissionMode).toBe(snapshot.policy.permissionMode)
  })
})

describe('快照冻结与「一轮一份」', () => {
  test('Given 解析后预设对象被改写 When 读取快照 Then 仍是解析时刻的值', () => {
    const source = preset({ permissionMode: 'auto', disabledToolGroups: ['automation'], skillSlugs: ['pdf'] })
    const snapshot = resolveAgentRuntimePolicySnapshot({ preset: source, presetReference: reference })
    source.permissionMode = 'bypassPermissions'
    source.disabledToolGroups = []
    source.skillSlugs = []
    expect(snapshot.policy.permissionMode).toBe('auto')
    expect(snapshot.policy.disabledToolGroups).toEqual(['automation'])
    expect(snapshot.policy.allowedSkillSlugs).toEqual(['pdf'])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.policy)).toBe(true)
  })

  test('Given 同一 runKey 多次读取 When 解析 Then 只解析一次并返回同一对象', () => {
    const registry = createAgentRuntimePolicyRunRegistry()
    const first = registry.resolveForRun('run-1', { preset: preset(), presetReference: reference })
    const second = registry.resolveForRun('run-1', { preset: preset({ permissionMode: 'plan' }), presetReference: reference })
    expect(second).toBe(first)
    expect(registry.resolutionCount()).toBe(1)
    expect(second.policy.permissionMode).toBe(PROFER_DEFAULT_PERMISSION_MODE)
  })

  test('Given 异步加载期间配置变化 When 本轮再次读取 Then 快照不变，下一轮读到新配置', () => {
    const registry = createAgentRuntimePolicyRunRegistry()
    let currentPreset = preset({ skillSlugs: ['pdf'] })
    const resolveFor = (runKey: string) => registry.resolveForRun(runKey, { preset: currentPreset, presetReference: reference })

    const runA = resolveFor('session-a')
    // 异步 MCP/Skill 注入期间用户改了预设：本轮必须仍然使用旧快照。
    currentPreset = preset({ skillSlugs: ['xlsx'], disabledToolGroups: ['browser'] })
    const runAAgain = resolveFor('session-a')
    expect(runAAgain).toBe(runA)
    expect(runAAgain.policy.allowedSkillSlugs).toEqual(['pdf'])
    expect(runAAgain.policy.disabledToolGroups).toEqual([])

    // 下一轮（释放后重新解析）读到新配置。
    registry.releaseRun('session-a')
    const runB = resolveFor('session-a')
    expect(runB).not.toBe(runA)
    expect(runB.policy.allowedSkillSlugs).toEqual(['xlsx'])
    expect(runB.policy.disabledToolGroups).toEqual(['browser'])
    expect(registry.resolutionCount()).toBe(2)
  })

  test('Given MCP 注入完成 When 刷新已加载 MCP Then 策略字段不变且保留解析时刻', () => {
    const snapshot = resolveAgentRuntimePolicySnapshot({ preset: preset(), presetReference: reference, now: () => 1234 })
    const updated = withPolicyLoadedMcpServers(snapshot, ['alpha', 'alpha', 'beta'])
    expect(updated.resolvedAt).toBe(1234)
    expect(updated.policy.loadedMcpServerNames).toEqual(['alpha', 'beta'])
    expect(updated.policy.permissionMode).toBe(snapshot.policy.permissionMode)
  })
})

describe('能力裁剪：工具组 / PPT / skill / MCP', () => {
  test('Given 预设禁用工具组与 allowSubagents=false When 解析快照 Then 与共享判定一致', () => {
    const snapshot = resolveAgentRuntimePolicySnapshot({
      preset: preset({ disabledToolGroups: ['ppt-materials'], allowSubagents: false }),
      presetReference: reference,
      runtimeSupportsSubagents: true,
    })
    expect(snapshot.policy.disabledToolGroups).toContain('ppt-materials')
    expect(snapshot.policy.disabledToolGroups).toContain('collaboration')
    expect(snapshot.policy.allowSubagents).toBe(false)
    expect(snapshot.policy.suppressPromptSections).toContain('subagents')
  })

  test('Given 策略工具装配上下文 When 真实 buildPiBuiltinTools 装配 Then 被禁工具组真的不注册', async () => {
    const snapshot = resolveAgentRuntimePolicySnapshot({
      preset: preset({ disabledToolGroups: ['ppt-materials', 'browser', 'clipboard'] }),
      presetReference: reference,
    })
    const baseContext = {
      sessionId: 'policy-tools',
      channelId: 'policy-channel',
      permissionMode: 'bypassPermissions',
      triggeredBy: 'user',
      agentCwd: '/tmp/policy-cwd',
      pptCapabilityActive: true,
    }
    const fakeSdk = { defineTool: (definition: unknown) => definition }
    const full = await buildPiBuiltinTools(fakeSdk as never, baseContext as never)
    const gatedContext = buildPolicyToolAssemblyContext(snapshot, baseContext)
    const gated = await buildPiBuiltinTools(fakeSdk as never, gatedContext as never)

    const fullNames = toolNames(full)
    const gatedNames = toolNames(gated)
    expect(fullNames).toContain('plan_ppt_visuals')
    expect(fullNames).toContain('BrowserNavigate')
    expect(fullNames).not.toContain('clipboard_read_text')
    expect(gatedNames).not.toContain('plan_ppt_visuals')
    expect(gatedNames).not.toContain('BrowserNavigate')
    expect(gatedNames).not.toContain('clipboard_read_text')
    expect(gatedNames.length).toBeLessThan(fullNames.length)
    // 未被禁用的组仍可用：策略只裁剪，不误伤。
    expect(gatedNames).toContain('open_file_preview')
    expect(gatedNames).toContain('WebSearch')
  })

  test('Given 策略未禁用任何组 When 装配上下文 Then 工具面与未裁剪时一致', async () => {
    const snapshot = resolveAgentRuntimePolicySnapshot({ preset: preset(), presetReference: reference, pptCapabilityActive: true })
    const baseContext = { sessionId: 'policy-tools-full', channelId: 'policy-channel', permissionMode: 'bypassPermissions', triggeredBy: 'user', agentCwd: '/tmp/policy-cwd', pptCapabilityActive: true }
    const fakeSdk = { defineTool: (definition: unknown) => definition }
    const base = await buildPiBuiltinTools(fakeSdk as never, baseContext as never)
    const withPolicy = await buildPiBuiltinTools(fakeSdk as never, buildPolicyToolAssemblyContext(snapshot, baseContext) as never)
    expect(toolNames(withPolicy).length).toBe(toolNames(base).length)
  })

  test('Given pptCapabilityActive=false When 真实装配 Then PPT 工具不注册（会话级门禁生效）', async () => {
    const fakeSdk = { defineTool: (definition: unknown) => definition }
    const baseContext = { sessionId: 'policy-ppt-tools', channelId: 'policy-channel', permissionMode: 'bypassPermissions', triggeredBy: 'user', agentCwd: '/tmp/policy-cwd', pptCapabilityActive: true }
    const enabled = await buildPiBuiltinTools(fakeSdk as never, baseContext as never)
    expect(toolNames(enabled)).toContain('plan_ppt_visuals')

    const snapshot = resolveAgentRuntimePolicySnapshot({ preset: preset(), presetReference: reference, pptCapabilityActive: false })
    const gated = await buildPiBuiltinTools(fakeSdk as never, buildPolicyToolAssemblyContext(snapshot, baseContext) as never)
    expect(toolNames(gated)).not.toContain('plan_ppt_visuals')
    expect(toolNames(gated)).not.toContain('audit_ppt_delivery')
  })

  test('Given pptCapabilityActive=false When 装配上下文 Then PPT 门禁进入工具装配字段', () => {
    const snapshot = resolveAgentRuntimePolicySnapshot({ preset: preset(), presetReference: reference, pptCapabilityActive: false })
    const context = buildPolicyToolAssemblyContext(snapshot, { sessionId: 'policy-ppt' })
    expect(context.pptCapabilityActive).toBe(false)
    expect(context.disabledToolGroups).toEqual([])
    expect(context.permissionMode).toBe(PROFER_DEFAULT_PERMISSION_MODE)
  })

  test('Given 策略 skill 白名单 When 真实路由与 runtime options Then 最终 skill 集等于白名单交集', async () => {
    const snapshot = resolveAgentRuntimePolicySnapshot({ preset: preset({ skillSlugs: ['pdf'] }), presetReference: reference })
    const projection = createSkillProjection(['pdf', 'xlsx', 'automation'])
    const filtered = filterPolicySkills(snapshot, projection.skills.map(skill => skill.slug))
    expect(filtered).toEqual(['pdf'])

    const routing = await prepareAgentSkillRouting({
      projection,
      policy: snapshot.policy,
      toolNames: ['Read', 'Bash'],
    })
    const claudeRuntime = buildSkillRuntimeOptions(routing)
    const piRuntime = buildSkillRuntimeOptions(routing, 'pi')
    expect(claudeRuntime.skills).toEqual(['pdf'])
    expect(claudeRuntime.skillSlugs).toEqual(['pdf'])
    expect(piRuntime.skillCatalogPrompt).toContain('pdf')
    expect(piRuntime.skillCatalogPrompt).not.toContain('xlsx')
  })

  test('Given 策略 MCP 白名单 When 过滤 resources Then 最终交给 provider 的 mcpServers 只含白名单项', () => {
    const snapshot = resolveAgentRuntimePolicySnapshot({ preset: preset({ mcpServerNames: ['alpha'] }), presetReference: reference })
    const resources = [
      { name: 'alpha', command: 'a' },
      { name: 'beta', command: 'b' },
    ]
    const filtered = filterPolicyMcpResources(snapshot, resources)
    expect(filtered.map(resource => resource.name)).toEqual(['alpha'])
    // 与旧路径同一判定函数：白名单外一律不允许。
    expect(snapshot.policy.allowedMcpServerNames).toEqual(['alpha'])
  })

  test('Given 空数组白名单 When 过滤 Then 表示全部禁用（与 undefined 语义区分）', () => {
    const none = resolveAgentRuntimePolicySnapshot({ preset: preset({ skillSlugs: [], mcpServerNames: [] }), presetReference: reference })
    expect(filterPolicySkills(none, ['pdf'])).toEqual([])
    expect(filterPolicyMcpResources(none, [{ name: 'alpha' }])).toEqual([])

    const unfiltered = resolveAgentRuntimePolicySnapshot({ preset: preset(), presetReference: reference })
    expect(filterPolicySkills(unfiltered, ['pdf'])).toEqual(['pdf'])
    expect(filterPolicyMcpResources(unfiltered, [{ name: 'alpha' }])).toEqual([{ name: 'alpha' }])
  })

  test('Given 禁用组与单工具 When collectPolicyDisallowedTools Then 与共享能力表一致', () => {
    const snapshot = resolveAgentRuntimePolicySnapshot({
      preset: preset({ disabledToolGroups: ['clipboard'], disabledTools: ['search_memory'] }),
      presetReference: reference,
    })
    const disallowed = collectPolicyDisallowedTools(snapshot)
    expect(disallowed).not.toContain('clipboard_read_text')
    expect(disallowed).toContain('clipboard_write_text')
    expect(disallowed).toContain('search_memory')
    const clipboardGroup = AGENT_PRESET_CAPABILITY_GROUPS.find(group => group.id === 'clipboard')
    expect(clipboardGroup?.toolNames.every(name => disallowed.includes(name))).toBe(true)
  })
})
