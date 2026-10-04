import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DefaultResourceLoader, SettingsManager, formatSkillsForPrompt, loadSkillsFromDir } from '@earendil-works/pi-coding-agent'
import { createEffectiveAgentPresetPolicy } from '@profer/shared'
import { prepareAgentSkillRouting, buildSkillRuntimeOptions } from './skill-runtime-routing'
import { routeSkillsForTask } from './skill-routing'
import { createPromaSkillsOverride } from './adapters/pi-skill-resources'
import type { ClaudeAgentQueryOptions } from './adapters/claude-agent-adapter'

let captured: { options: Record<string, unknown>; prompt: unknown } | undefined
mock.module('@anthropic-ai/claude-agent-sdk', () => ({ query: (input: { options: Record<string, unknown>; prompt: unknown }) => {
  captured = input
  return (async function* () { yield { type: 'result', subtype: 'success', terminal_reason: 'completed', session_id: 'mock' } })()
} }))
const { ClaudeAgentAdapter } = await import('./adapters/claude-agent-adapter')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function prepare(slugs: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'profer-skill-chain-'))
  roots.push(root)
  const skills = ['alpha', 'beta', 'pdf', 'automation'].map(slug => {
    const path = join(root, 'skills', slug)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'SKILL.md'), `---\n"name": shared-name\ndescription: test skill\n---\nSECRET_${slug}\n`)
    // 依赖由模块自己声明：automation 组被预设关闭时，这个 Skill 必须整块不可用。
    if (slug === 'automation') writeFileSync(join(path, 'SKILL.json'), JSON.stringify({ schemaVersion: 1, dependencies: { toolGroups: ['automation'] } }))
    return { slug, name: 'shared-name', path, version: '1', scope: 'workspace' as const, actualSource: 'workspace' as const }
  })
  const policy = createEffectiveAgentPresetPolicy({ id: 'test', name: 'test', description: '', isBuiltin: false, createdAt: 0, updatedAt: 0, skillSlugs: slugs, disabledToolGroups: ['automation'] }, { presetId: 'test', presetScope: 'workspace', workspaceSlug: 'ws' }, { runtimeSupportsSubagents: true })
  const routing = await prepareAgentSkillRouting({ projection: { path: root, skills, diagnostics: [] }, policy, toolNames: ['Read', 'Bash'] })
  const runtime = buildSkillRuntimeOptions(routing)
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, noContextFiles: true, noExtensions: true, noSkills: true, additionalSkillPaths: [], settingsManager: SettingsManager.inMemory(), skillsOverride: createPromaSkillsOverride(runtime.additionalSkillPaths, runtime.skillSlugs, loadSkillsFromDir) })
  await loader.reload()
  return { root, routing, runtime, loader }
}

describe('共享策略 → 实际 adapter/SDK Skill 链路', () => {
  test('同名 alpha/beta 仅允许 beta，Claude 最终 options 和 Pi 实际目录一致', async () => {
    const { routing, runtime, loader } = await prepare(['beta', 'pdf', 'automation'])
    expect(runtime.skills).toEqual(['beta', 'pdf'])
    expect(loader.getSkills().skills.map(s => s.name)).toEqual(['beta', 'pdf'])
    const catalog = formatSkillsForPrompt(loader.getSkills().skills)
    expect(catalog).not.toContain('<name>alpha</name>')
    expect(catalog).not.toContain('<name>automation</name>')
    const route = routeSkillsForTask(routing.snapshot, { userMessage: '/skill:beta /skill:automation 合并 PDF 文件' })
    expect(route.prompt).toContain('SECRET_beta')
    expect(route.prompt).toContain('SECRET_pdf')
    expect(route.prompt).not.toContain('SECRET_automation')
    const adapter = new ClaudeAgentAdapter()
    const input: ClaudeAgentQueryOptions = { sessionId: 'chain', prompt: route.prompt, sdkCliPath: '/mock', env: {}, sdkPermissionMode: 'auto', allowDangerouslySkipPermissions: false, systemPrompt: 'test', ...runtime }
    try {
      for await (const _message of adapter.query(input)) { /* 消费最终 SDK query */ }
      expect(captured?.options.skills).toEqual(runtime.skills)
      expect(captured?.options.plugins).toEqual(runtime.plugins)
      expect(runtime.skillMentions).toEqual([])
    } finally { adapter.dispose() }
    // 追加消息同样使用冻结快照，但按最新用户意图重选，不复用上一条推荐。
    const queued = routeSkillsForTask(routing.snapshot, { userMessage: '/skill:alpha 你好' })
    expect(queued.recommended).toEqual([])
    expect(queued.prompt).toContain('preset-denied')
    expect(queued.prompt).not.toContain('SECRET_')
  })
  test('全禁不会通过 loader 或 options 退回默认全部 Skill', async () => {
    const { routing, runtime, loader } = await prepare([])
    expect(runtime.skills).toEqual([])
    expect(runtime.skillSlugs).toEqual([])
    expect(loader.getSkills().skills).toEqual([])
    expect(routeSkillsForTask(routing.snapshot, { userMessage: '/skill:pdf' }).prompt).not.toContain('SECRET_pdf')
  })
})
