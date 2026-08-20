/**
 * Profer 自带默认 Skill 的历史 slug 兼容。
 *
 * 仅维护应用明确改名过的默认 Skill；绝不对用户自建 Skill 做模糊替换。
 */
export const RENAMED_DEFAULT_SKILLS: ReadonlyMap<string, string> = new Map([
  ['proma-coach', 'profer-coach'],
])

/** 将历史默认 Skill slug 归一化为当前 slug；未知 slug 原样返回。 */
export function normalizeDefaultSkillSlug(slug: string): string {
  return RENAMED_DEFAULT_SKILLS.get(slug) ?? slug
}

/**
 * 归一化预设/历史消息里的 Skill 列表，并保留白名单的 undefined / 空数组语义。
 * 同时去重，避免旧新 slug 并存时重复注入同一默认 Skill。
 */
export function normalizeDefaultSkillSlugs(slugs: string[] | undefined): string[] | undefined {
  if (slugs === undefined) return undefined
  return [...new Set(slugs.map(normalizeDefaultSkillSlug))]
}
