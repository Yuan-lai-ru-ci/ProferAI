import { assertResourcePath } from './resource-paths'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { GlobalSkillManifest, ResolvedSkillMeta, WorkspaceSkillOverridesFile, WorkspaceSkillSource } from '@profer/shared'
import { resolveSkillSources } from '@profer/agent-provider-pi/skills/skill-resolution'
import { assertSafeSkillSegment } from '@profer/agent-provider-pi/skills/skill-path-security'
import { readSkillDescriptor } from '@profer/agent-provider-pi/skills/skill-manifest'
import type { CoreConfig } from './config'

function read(path: string): Record<string, unknown> | undefined {
  assertResourcePath(path)
  if (!existsSync(path)) return undefined
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Core Skill来源配置格式错误')
  return value as Record<string, unknown>
}

/** 只读全局定义；不执行旧账本改名或修复。 */
export function readCoreGlobalSkillDefinitions(config: CoreConfig) {
  const globals: Array<GlobalSkillManifest & { path: string }> = []
  for (const [directory, type] of [['builtin', 'builtin-meta'], ['user', 'user-global']] as const) {
    const root = join(config.configDir, 'global-skills', directory)
    assertResourcePath(root)
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue
      assertSafeSkillSegment(entry.name, 'global skillId')
      if (entry.isSymbolicLink()) throw new Error('Core不支持软链全局Skill来源')
      if (!entry.isDirectory()) continue
      const path = join(root, entry.name)
      const value = read(join(path, 'skill-library.json')) ?? read(join(path, 'skill.manifest.json'))
      if (!value || value.schemaVersion !== 1 || value.skillId !== entry.name || value.type !== type || typeof value.slug !== 'string' || typeof value.name !== 'string' || typeof value.version !== 'string') throw new Error('Core全局Skill账本无效，不按同名猜测来源')
      assertSafeSkillSegment(value.slug, 'global Skill slug')
      assertResourcePath(join(path, 'SKILL.md')); assertResourcePath(join(path, 'SKILL.json'))
      if (!existsSync(join(path, 'SKILL.md'))) throw new Error('Core全局Skill正文缺失')
      globals.push({ ...(value as unknown as GlobalSkillManifest), path })
    }
  }
  return globals
}

/** 只读Core来源；不执行旧账本改名/修复/UUID回填，不写入用户Skill库。 */
export function resolveCoreSkillSources(config: CoreConfig, workspaceConfigDir?: string) {
  const globals = readCoreGlobalSkillDefinitions(config)
  const raw = workspaceConfigDir ? read(join(workspaceConfigDir, 'skill-overrides.json')) : undefined
  if (raw && (raw.schemaVersion !== 1 || !raw.globalSkills || typeof raw.globalSkills !== 'object' || Array.isArray(raw.globalSkills))) throw new Error('Core Skill覆盖配置格式错误')
  const overrides = (raw ?? { schemaVersion: 1, globalSkills: {} }) as unknown as WorkspaceSkillOverridesFile
  for (const override of Object.values(overrides.globalSkills)) {
    if (!override || typeof override.enabled !== 'boolean' || override.replacementWorkspaceSkillId !== undefined && typeof override.replacementWorkspaceSkillId !== 'string' || override.replacementWorkspaceSkillSlug !== undefined && typeof override.replacementWorkspaceSkillSlug !== 'string') throw new Error('Core Skill覆盖条目无效')
  }
  const local: ResolvedSkillMeta[] = [], localAll: ResolvedSkillMeta[] = []
  if (workspaceConfigDir) for (const [directory, enabled] of [['skills', true], ['skills-inactive', false]] as const) {
    const root = join(workspaceConfigDir, directory)
    assertResourcePath(root)
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue
      assertSafeSkillSegment(entry.name, 'workspace Skill slug')
      if (entry.isSymbolicLink()) throw new Error('Core不支持软链工作区Skill来源')
      const path = join(root, entry.name)
      if (!entry.isDirectory() || !existsSync(join(path, 'SKILL.md'))) continue
      if (lstatSync(join(path, 'SKILL.md')).isSymbolicLink()) throw new Error('Core不支持软链Skill正文')
      const source = read(join(path, '.source.json')) as WorkspaceSkillSource | undefined
      assertResourcePath(join(path,'SKILL.json'))
      const descriptor = readSkillDescriptor(path, entry.name).descriptor
      const meta: ResolvedSkillMeta = { ...source, slug: entry.name, name: descriptor.name, version: descriptor.version, path, scope: 'workspace', actualSource: 'workspace' }
      localAll.push(meta)
      if (enabled) local.push(meta)
    }
  }
  return resolveSkillSources({ overrides, globals, local, localAll })
}
