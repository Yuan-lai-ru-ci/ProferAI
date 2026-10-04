/**
 * 技能详情里「路由卡片」表单 ⇄ SKILL.json 补丁的纯转换。
 *
 * 分工（重要）：
 * - **“什么时候用”写在描述里**（SKILL.md frontmatter 的 description，例如 “Use when: …”）。
 *   那是模型真正读到的文本，也是唯一一份；表单不提供第二个写词的地方。
 * - **卡片只装程序能判定的声明**：需要哪些能力组/工具、是否只接受显式引用。
 *   卡片里的 triggers（旧词表/侧车迁移）保持只读、保存时不碰，留给兼容与回溯。
 */
import type { AgentPresetToolGroup, SkillManifest, SkillManifestPatch } from '@profer/shared'

export interface SkillCardForm {
  /** 需要的能力组（工具组）。 */
  toolGroups: AgentPresetToolGroup[]
  /** 需要但不在能力组里的工具名（如 mcp__server__tool）。 */
  tools: string
  /** true = 只接受 `/skill:<slug>` 显式引用（等价 implicit:false）。 */
  explicitOnly: boolean
}

export const EMPTY_SKILL_CARD_FORM: SkillCardForm = { toolGroups: [], tools: '', explicitOnly: false }

/** 分隔符按中文习惯多收几种：逗号、顿号、分号、换行；去空白、去重、保序。 */
export function splitPhrases(text: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of text.split(/[,，、;；\n\r]+/)) {
    const item = raw.trim()
    if (!item || seen.has(item)) continue
    seen.add(item)
    result.push(item)
  }
  return result
}

export function joinPhrases(items: readonly string[] | undefined): string {
  return (items ?? []).join('、')
}

export function cardFormFromManifest(manifest: SkillManifest | undefined): SkillCardForm {
  if (!manifest) return { ...EMPTY_SKILL_CARD_FORM }
  return {
    toolGroups: [...(manifest.dependencies?.toolGroups ?? [])],
    tools: joinPhrases(manifest.dependencies?.tools),
    explicitOnly: manifest.policy?.implicit === false,
  }
}

/**
 * 表单 → 补丁：只提交依赖与触发方式，**不包含 triggers**。
 * 手写/迁移来的触发词保留在卡片里，不在界面里被静默删掉。
 */
export function cardPatchFromForm(form: SkillCardForm): SkillManifestPatch {
  const tools = splitPhrases(form.tools)
  return {
    dependencies: form.toolGroups.length || tools.length ? { toolGroups: form.toolGroups, tools } : null,
    policy: { implicit: form.explicitOnly ? false : null },
  }
}

/** 表单是否有内容：用于判断「没卡片」是空表单还是用户确实写了东西。 */
export function isSkillCardFormEmpty(form: SkillCardForm): boolean {
  return !form.tools.trim() && form.toolGroups.length === 0 && !form.explicitOnly
}
