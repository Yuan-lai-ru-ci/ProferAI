/**
 * Agent 技能列表的分区与身份判定（纯函数，供 AgentSkillsView / 详情抽屉复用）。
 *
 * 关键契约：工作区副本的稳定身份是 `workspaceSkillId`；`actualSource` 只表示「当前实际
 * 加载层」。被关闭的工作区 Skill 会被移到 `skills-inactive/`，重新扫描时拿到的是
 * `actualSource: 'none'`。若用 `actualSource === 'workspace'` 判断归属，已关闭的副本会
 * 同时被工作区 / 全局 / 内置三个分区排除，而列表总数仍 > 0，于是它从配置页彻底消失、
 * 无法再被打开或重新启用。归属判定必须只认身份，不认加载层。
 */

import type { SkillMeta } from '@profer/shared'

/** 工作区本地 Skill（含已关闭、位于 skills-inactive/ 的副本）：按稳定 ID 判定。 */
export function isWorkspaceLocalSkill(skill: SkillMeta): boolean {
  return skill.scope === 'workspace' || Boolean(skill.workspaceSkillId)
}

/** 从全局库定义派生的引用条目（不含工作区副本身份）。 */
export function isGlobalReferenceSkill(skill: SkillMeta): boolean {
  return (
    !isWorkspaceLocalSkill(skill) &&
    skill.sourceSkillType === 'user-global' &&
    skill.actualSource !== 'workspace'
  )
}

/** 从内置元 Skill 定义派生的引用条目（不含工作区副本身份）。 */
export function isBuiltinReferenceSkill(skill: SkillMeta): boolean {
  return (
    !isWorkspaceLocalSkill(skill) &&
    skill.sourceSkillType === 'builtin-meta' &&
    skill.actualSource !== 'workspace'
  )
}

export interface SkillListSections {
  workspaceSkills: SkillMeta[]
  globalSkills: SkillMeta[]
  builtinSkills: SkillMeta[]
}

/** 按身份把 Skill 列表切成三个展示分区；每个条目只会落在一个分区里。 */
export function partitionSkills(skills: SkillMeta[]): SkillListSections {
  return {
    workspaceSkills: skills.filter(isWorkspaceLocalSkill),
    globalSkills: skills.filter(isGlobalReferenceSkill),
    builtinSkills: skills.filter(isBuiltinReferenceSkill),
  }
}

/** 列表与详情的稳定 key：工作区副本按 workspaceSkillId，全局定义按来源 ID。 */
export function skillListKey(skill: SkillMeta): string {
  return isWorkspaceLocalSkill(skill)
    ? `workspace:${skill.workspaceSkillId ?? skill.slug}`
    : `global:${skill.sourceSkillId ?? skill.slug}`
}

/**
 * toggle IPC 的 sourceSkillId 参数（三态语义）：
 * - 工作区副本（含已关闭）必须传空字符串，走 skills/ ⇄ skills-inactive/ 目录移动；
 *   传了来源 ID 会误改同名全局定义的启用状态，而不是把这个副本打开。
 * - 全局引用条目传来源 ID，改的是该工作区的 override。
 */
export function skillToggleSourceId(skill: SkillMeta): string {
  return isWorkspaceLocalSkill(skill) ? '' : (skill.sourceSkillId ?? '')
}

/** 点击「打开目录」应打开的真实路径；已关闭的副本在 skills-inactive/ 下。 */
export function skillDirectoryPath(skill: SkillMeta, skillsDir: string): string {
  if (!skillsDir) return ''
  const base =
    isWorkspaceLocalSkill(skill) && !skill.enabled
      ? `${skillsDir}/../skills-inactive`
      : skillsDir
  return `${base}/${skill.slug}`
}

/** 工作区副本在磁盘上的相对位置，供详情页「位置」行展示。全局引用不在本地目录，故为不适用。 */
export function skillLocationLabel(skill: SkillMeta): string {
  if (!isWorkspaceLocalSkill(skill)) return '—'
  return `${skill.enabled ? 'skills' : 'skills-inactive'}/${skill.slug}`
}
