/** 来源/替换合并规则提取自既有global-skill-manager；不读写文件。 */
import type { GlobalSkillManifest, ResolvedSkillMeta, RuntimeSkillsProjection, WorkspaceSkillOverridesFile } from '@profer/shared'
import { canonicalSkillSegmentKey } from './skill-path-security'

export function resolveSkillSources(input: { overrides: WorkspaceSkillOverridesFile; local: ResolvedSkillMeta[]; localAll: ResolvedSkillMeta[]; globals: Array<GlobalSkillManifest & { path: string }> }): RuntimeSkillsProjection {
  const { overrides, local, localAll, globals } = input
  const globalsById = new Map(globals.map(skill => [skill.skillId, skill]))
  // restoreGlobalSkill 只清除 replacement，不删除副本；带来源的 active 副本此时作为备份保留，
  // 不能再次以同 slug 抢占已恢复的全局源。来源删除或 replacement 状态仍允许副本继续生效。
  const effectiveLocal = local.filter((skill) => {
    if (!skill.sourceSkillId) return true
    const source = globalsById.get(skill.sourceSkillId)
    const override = source ? overrides.globalSkills[source.skillId] : undefined
    if (source && override?.enabled === true && !override.replacementWorkspaceSkillId && !override.replacementWorkspaceSkillSlug) return false
    // replacement 必须按稳定 ID 命中；仅旧数据缺少 ID 时才以来源 ID 回退，绝不按 slug 猜测。
    if (source && override?.enabled === false && (override.replacementWorkspaceSkillId || override.replacementWorkspaceSkillSlug)) {
      return override.replacementWorkspaceSkillId
        ? skill.workspaceSkillId === override.replacementWorkspaceSkillId
        : skill.sourceSkillId === source.skillId
    }
    return true
  })
  const localBySlug = new Map(effectiveLocal.map((skill) => [canonicalSkillSegmentKey(skill.slug), skill]))
  const result: ResolvedSkillMeta[] = []
  const resolvedSlugKeys = new Set<string>()
  const diagnostics: RuntimeSkillsProjection['diagnostics'] = []

  for (const global of globals) {
    const override = overrides.globalSkills[global.skillId]
    if (override?.enabled === false) {
      const replacementPresent = override.replacementWorkspaceSkillId
        ? localAll.some((skill) => skill.workspaceSkillId === override.replacementWorkspaceSkillId)
        : Boolean(override.replacementWorkspaceSkillSlug && localAll.some((skill) => skill.sourceSkillId === global.skillId))
      if ((override.replacementWorkspaceSkillId || override.replacementWorkspaceSkillSlug) && !replacementPresent) {
        diagnostics.push({
          code: 'replacement-missing',
          skillId: global.skillId,
          slug: override.replacementWorkspaceSkillSlug,
          message: `工作区副本不存在或已禁用，原全局 Skill 仍保持禁用: ${global.slug}`,
        })
      }
      continue
    }
    const globalSlugKey = canonicalSkillSegmentKey(global.slug)
    const localConflict = localBySlug.get(globalSlugKey)
    if (localConflict) {
      diagnostics.push({
        code: 'workspace-slug-conflict',
        skillId: global.skillId,
        slug: global.slug,
        message: `工作区 Skill 与全局 Skill 同名，已按工作区优先加载: ${global.slug}`,
      })
      continue
    }
    if (resolvedSlugKeys.has(globalSlugKey)) {
      diagnostics.push({ code: 'workspace-slug-conflict', skillId: global.skillId, slug: global.slug, message: `重复全局 Skill 已忽略: ${global.slug}` })
      continue
    }
    result.push({
      slug: global.slug,
      name: global.name,
      version: global.version,
      path: global.path,
      scope: 'global',
      sourceSkillId: global.skillId,
      sourceStatus: 'available',
      actualSource: 'global',
      ...(global.source ? {
        sourceSkillType: global.source.sourceSkillType,
        sourceVersion: global.source.sourceVersion,
        copiedAt: global.source.copiedAt,
      } : {}),
    })
    resolvedSlugKeys.add(globalSlugKey)
  }

  for (const skill of effectiveLocal) {
    const skillSlugKey = canonicalSkillSegmentKey(skill.slug)
    if (resolvedSlugKeys.has(skillSlugKey)) {
      diagnostics.push({ code: 'workspace-slug-conflict', slug: skill.slug, message: `重复 Skill 已忽略: ${skill.slug}` })
      continue
    }
    result.push(skill)
    resolvedSlugKeys.add(skillSlugKey)
  }
  return { path: '', skills: result, diagnostics }
}
