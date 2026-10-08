import type { AgentRuntime, EffectiveAgentPresetPolicy, RuntimeSkillsProjection } from '@profer/shared'
import { getRuntimeSkillsPath, preparePolicyRuntimeSkills } from './global-skill-manager'
import { buildSkillCatalog, createSkillRoutingSnapshot, type SkillRoutingSnapshot } from './skill-routing'
import { join } from 'node:path'

export interface PreparedSkillRouting {
  snapshot: SkillRoutingSnapshot
  projection?: RuntimeSkillsProjection
}

/** 两端使用同一份策略投影；catalog 保留合法非推荐项，推荐不影响权限。 */
export async function prepareAgentSkillRouting(input: {
  projection?: RuntimeSkillsProjection
  policy: EffectiveAgentPresetPolicy
  toolNames: readonly string[]
}): Promise<PreparedSkillRouting> {
  const source = await createSkillRoutingSnapshot(input)
  if (!input.projection) return { snapshot: source }
  const projection = await preparePolicyRuntimeSkills(input.projection, source.allowedSlugs)
  return {
    projection,
    snapshot: Object.freeze({
      allowedSlugs: source.allowedSlugs,
      skills: Object.freeze(source.skills.map(skill => Object.freeze({
        ...skill,
        filePath: join(projection.path, 'skills', skill.slug, 'SKILL.md'),
        rootPath: join(projection.path, 'skills'),
      }))),
    }),
  }
}

/** 必须用于实际 adapter query，避免两端字段重新各自拼装而漂移。 */
export function buildSkillRuntimeOptions(routing: PreparedSkillRouting, runtime: AgentRuntime = 'claude') {
  if (runtime === 'pi') {
    // catalog 与正文均由 Profer 提供，SDK 不再发现/展开 Skill；目录权限不因此变化。
    return {
      skills: [] as string[],
      skillSlugs: [] as string[],
      skillMentions: [] as string[],
      additionalSkillPaths: [] as string[],
      plugins: [] as Array<{ type: 'local'; path: string }>,
      skillCatalogPrompt: buildSkillCatalog(routing.snapshot),
    }
  }
  return {
    skillCatalogPrompt: '',
    skills: [...routing.snapshot.allowedSlugs],
    skillSlugs: [...routing.snapshot.allowedSlugs],
    // 共享路由已处理原始用户引用，不允许 adapter 从历史/内部上下文再次扫描。
    skillMentions: [] as string[],
    additionalSkillPaths: routing.projection ? [getRuntimeSkillsPath(routing.projection)] : [],
    plugins: routing.projection ? [{ type: 'local' as const, path: routing.projection.path }] : [],
  }
}
