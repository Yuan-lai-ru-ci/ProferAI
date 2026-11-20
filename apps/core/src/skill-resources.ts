import { mkdirSync, readdirSync, realpathSync, statSync, lstatSync, copyFileSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import type { EffectiveAgentPresetPolicy, RuntimeSkillsProjection } from '@profer/shared'
import { createSkillRoutingSnapshot, buildSkillCatalog, routeSkillsForTask } from '@profer/agent-provider-pi/skills/skill-routing'
import { assertSafeSkillSegment } from '@profer/agent-provider-pi/skills/skill-path-security'
import { resolveCoreSkillSources } from './skill-sources'
import type { CoreConfig } from './config'

function contained(root: string, path: string): boolean {
  const rel = relative(realpathSync(root), realpathSync(path))
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)
}
function copySkill(source: string, destination: string, root = source): void {
  if (lstatSync(source).isSymbolicLink() || !contained(root, source)) throw new Error('Skill含不支持的软链或越界路径')
  if (statSync(source).isFile()) { copyFileSync(source, destination); return }
  mkdirSync(destination, { recursive: true })
  for (const item of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.name === 'node_modules' || item.name === '.git' || item.name === '.source.json' || item.name === 'skill-library.json') continue
    copySkill(join(source, item.name), join(destination, item.name), root)
  }
}

/** 每Run私有只读Skill投影；路由/依赖/正文预算全部使用既有共享实现。 */
export async function prepareCoreWorkspaceSkills(input: {
  config: CoreConfig; workspaceConfigDir?: string; sessionId: string; runId: string; policy: EffectiveAgentPresetPolicy; toolNames: string[]; prompt: string
}): Promise<{ system: string; task: string; loaded: string[] }> {
  if (!/^[a-zA-Z0-9-]+$/.test(input.runId)) throw new Error('Skill资源Run身份无效')
  const selected = input.policy.allowedSkillSlugs === undefined ? undefined : new Set(input.policy.allowedSkillSlugs)
  const empty = () => ({ system: '', task: routeSkillsForTask({ skills: [], allowedSlugs: [] }, { userMessage: input.prompt }).prompt, loaded: [] as string[] })
  // 显式关闭全部Skills时不读取被禁用的任何资源根。
  if (selected?.size === 0) return empty()
  const resolution = resolveCoreSkillSources(input.config, input.workspaceConfigDir)
  const skills = resolution.skills.filter(skill => !selected || selected.has(skill.slug))
  for (const skill of skills) assertSafeSkillSegment(skill.slug, 'Core Skill slug')
  if (selected && [...selected].some(slug => !skills.some(skill => skill.slug === slug))) throw new Error('Core预设所需Skill不存在或不可读')
  if (!skills.length) return empty()
  const projectionPath = join(input.config.configDir, 'core-resources', input.sessionId, input.runId)
  const source: RuntimeSkillsProjection = { ...resolution, path: projectionPath, skills }
  const checked = await createSkillRoutingSnapshot({ projection: source, policy: input.policy, toolNames: input.toolNames, useSourcePaths: true })
  if (selected && checked.skills.some(skill => skill.blocked)) throw new Error(`Core所需Skill依赖不可用：${checked.skills.filter(skill => skill.blocked).map(skill => `${skill.slug}:${skill.blocked}`).join(', ')}`)
  const allowed = checked.allowedSlugs
  for (const skill of skills.filter(skill => allowed.includes(skill.slug))) copySkill(skill.path, join(projectionPath, 'skills', skill.slug))
  const snapshot = await createSkillRoutingSnapshot({ projection: { ...source, path: projectionPath, skills: skills.filter(skill => allowed.includes(skill.slug)) }, policy: input.policy, toolNames: input.toolNames })
  const routed = routeSkillsForTask(snapshot, { userMessage: input.prompt })
  return { system: buildSkillCatalog(snapshot), task: routed.prompt, loaded: [...snapshot.allowedSlugs] }
}
