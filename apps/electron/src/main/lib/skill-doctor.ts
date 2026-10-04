/**
 * Skill 医生：把「这个模块能不能被管理、能不能被联想到、依赖是否成立」变成可展示的诊断。
 *
 * 只读、不修改文件，也不阻止加载：清单坏了、描述写得不好都只是诊断（error 也要由调用方
 * 决定是否降级），因为用户自带技能不该被我们的规则挡在门外。硬约束（路径安全、正文超限）
 * 仍由 skill-routing / skill-manifest 在读取时把关。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { skillManifestToRoutingFields, type EffectiveAgentPresetPolicy, type SkillDoctorIssue, type SkillDoctorSeverity } from '@profer/shared'
import { VISUALIZATION_HOST_PRIMITIVES } from '../../shared/visualization-style'
import { readSkillDescriptor, SKILL_MANIFEST_FILENAME } from './skill-manifest'
import { builtinSkillRules, mergeSkillRoutingLayers, skillToolAvailable } from './skill-routing'
import type { SkillRoutingRules } from './skill-routing-rules'

// 诊断码与严重度定义在 @profer/shared：主进程产出、渲染层展示同一套码值。
export type { SkillDoctorCode, SkillDoctorIssue, SkillDoctorSeverity } from '@profer/shared'

export interface SkillDoctorInput {
  dir: string
  /** 目录名；缺省取目录 basename。 */
  slug?: string
  /** 已合并生效的规则（含内置依赖）；用于判断 implicit / 触发词 / 依赖。 */
  rules?: SkillRoutingRules
  /** 旧侧车声明的字段；用于报「清单与侧车重复来源」。 */
  sidecar?: SkillRoutingRules
  toolNames?: readonly string[]
  policy?: EffectiveAgentPresetPolicy
}

/** 描述里出现这些词说明写了「什么时候用」；只有介绍没有场景，路由和模型都难联想到。 */
const USAGE_MARKERS = /(?:用于|适用于|当用户|当需要|需要.{0,6}时|时用|时使用|场景|触发|Use (?:this skill |this |when|whenever|for)|whenever|when (?:they|someone|a user)|Trigger|before any|helps (?:with|you))/i
/** 正文超过该体积时提示拆分：路由注入与模型读取都会变贵。 */
export const SKILL_BODY_WARN_BYTES = 64 * 1024
const DESCRIPTION_MIN_CHARS = 12

/**
 * 宿主契约登记表：清单里 `requires.hostClasses` 声明的语义类必须在这里存在。
 * 新宿主契约（下一类可视化、编辑器等）在此登记，doctor 与清单即可自动对齐。
 */
export const HOST_CONTRACT_CLASSES: readonly string[] = VISUALIZATION_HOST_PRIMITIVES

const ROUTING_FIELDS = ['keywords', 'excludeKeywords', 'implicit', 'requiredTools', 'requiredMcpServers', 'requiredToolGroups'] as const

function declared(value: unknown): boolean {
  if (value === undefined) return false
  if (Array.isArray(value)) return value.length > 0
  return true
}

function bodyBytes(dir: string): number {
  const file = join(dir, 'SKILL.md')
  if (!existsSync(file)) return 0
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/**
 * 单个 Skill 的诊断。清单缺失只报 info；损坏、描述缺失、依赖不可用等按严重度分级。
 */
export function diagnoseSkill(input: SkillDoctorInput): SkillDoctorIssue[] {
  const issues: SkillDoctorIssue[] = []
  const read = readSkillDescriptor(input.dir, input.slug)
  const { descriptor, manifest, manifestIssues, manifestPresent, frontmatter } = read

  if (!manifestPresent) {
    issues.push({ code: 'manifest-missing', severity: 'info', message: `没有 ${SKILL_MANIFEST_FILENAME}：元数据、依赖与来源只能从 frontmatter / 侧车推导` })
  }
  for (const issue of manifestIssues) {
    if (issue.code === 'duplicate-description') continue
    issues.push({
      code: issue.code === 'unknown-field' ? 'manifest-unknown-field' : 'manifest-invalid',
      severity: issue.severity,
      message: issue.message,
      ...(issue.field ? { field: issue.field } : {}),
    })
  }

  // 清单与 frontmatter 同时声明同一元数据却不一致：这是第二份真相，必须提示。
  // 目录名才是 slug 权威：清单只能声明同名，不能把 Skill 指向另一个位置。
  if (descriptor.declaredSlug && descriptor.declaredSlug !== descriptor.slug) {
    issues.push({ code: 'manifest-slug-mismatch', severity: 'warning', field: 'slug', message: `清单 slug（${descriptor.declaredSlug}）与目录名（${descriptor.slug}）不一致，加载位置仍按目录名` })
  }
  if (manifest?.name && frontmatter.name && manifest.name !== frontmatter.name) {
    issues.push({ code: 'manifest-frontmatter-mismatch', severity: 'warning', field: 'name', message: `清单 name 与 frontmatter 不一致：${manifest.name} / ${frontmatter.name}` })
  }
  if (manifest?.version && frontmatter.version && manifest.version !== frontmatter.version) {
    issues.push({ code: 'manifest-frontmatter-mismatch', severity: 'warning', field: 'version', message: `清单 version 与 frontmatter 不一致：${manifest.version} / ${frontmatter.version}（生效的是清单版本）` })
  }

  // 路由字段同时写在清单与侧车里：建议只留一处，运行时按清单逐字段优先。
  const manifestFields = skillManifestToRoutingFields(manifest) as Record<string, unknown>
  const sidecarFields = (input.sidecar ?? {}) as Record<string, unknown>
  const duplicated = ROUTING_FIELDS.filter(field => declared(manifestFields[field]) && declared(sidecarFields[field]))
  if (duplicated.length) {
    issues.push({ code: 'routing-duplicated', severity: 'warning', field: duplicated.join('、'), message: `清单与 profer-routing.json 同时声明了路由字段：${duplicated.join('、')}；建议只保留清单` })
  }

  // 生效规则：内置兜底 → 旧侧车 → 模块清单 → 调用方传入（已合并的运行时规则）。
  // 清单是模块自己声明的真相，侧车只是迁移期的回退，两者同时声明会被 routing-duplicated 报出。
  const rules: SkillRoutingRules = mergeSkillRoutingLayers(
    builtinSkillRules(descriptor.slug),
    input.sidecar ?? {},
    skillManifestToRoutingFields(manifest),
    input.rules ?? {},
  )
  const keywords = rules.keywords ?? []

  const description = descriptor.description
  if (!description) {
    issues.push({ code: 'description-missing', severity: 'error', message: '缺少描述：模型与路由都无法联想到这个 Skill' })
  } else {
    if (description.length < DESCRIPTION_MIN_CHARS) issues.push({ code: 'description-too-short', severity: 'warning', message: `描述只有 ${description.length} 字，建议写清做什么、什么时候用` })
    // 描述是模型唯一读得到的那段文字（卡片里的词表模型看不到），所以“什么时候用”必须写在描述里。
    if (!USAGE_MARKERS.test(description)) {
      issues.push({ code: 'description-no-usage-marker', severity: 'warning', message: '描述里没有「什么时候用」的场景说明（如 Use when: 画图表、流程图）：模型只读得到描述，很难联想到这个 Skill' })
    }
  }

  if (rules.implicit !== false && keywords.length === 0) {
    issues.push({ code: 'keywords-missing', severity: 'info', message: '没有词表：只靠描述与模型联想命中（这是推荐做法，不用补词表）' })
  }
  if (keywords.length) {
    issues.push({ code: 'keywords-deprecated', severity: 'info', message: '词表已弃用，仅为兼容保留：新 Skill 请把用户的说法写进描述，不要再写词表' })
  }
  if (keywords.length) {
    // 词表只有路由代码读得到，模型看不到。只提醒“描述里既没写、也不包含任何已写词”的那些词：
    // 像“堆叠柱状图”这种变体，“柱状图”已经在描述里了，词形重叠本身就带得上信号。
    const lowered = description?.toLowerCase() ?? ''
    const covered = (word: string): boolean => Boolean(lowered) && lowered.includes(word.toLowerCase())
    const worthAdding = keywords.filter(word => {
      if (covered(word)) return false
      const overlap = keywords.some(other => other !== word && covered(other) && (word.toLowerCase().includes(other.toLowerCase()) || other.toLowerCase().includes(word.toLowerCase())))
      return !overlap
    })
    if (worthAdding.length > 0) {
      issues.push({
        code: 'triggers-in-manifest',
        severity: 'info',
        field: 'triggers.keywords',
        message: `有 ${worthAdding.length} 个词表词描述里没写（如 ${worthAdding.slice(0, 3).join('、')}）：模型读不到词表，建议把它们也写进描述`,
      })
    }
  }
  if (keywords.length && description && keywords.every(keyword => description.toLowerCase().includes(keyword.toLowerCase()))) {
    issues.push({ code: 'keywords-redundant', severity: 'info', message: '词表词都已写在描述里：词表只剩确定性匹配的作用，不再是补充信息' })
  }

  if (input.toolNames) {
    const tools = new Set(input.toolNames)
    for (const tool of rules.requiredTools ?? []) {
      if (!skillToolAvailable(tool, tools, input.policy)) issues.push({ code: 'dependency-tool-unavailable', severity: 'warning', message: `依赖的工具当前不可用: ${tool}` })
    }
  }
  if (input.policy) {
    for (const group of rules.requiredToolGroups ?? []) {
      if (input.policy.disabledToolGroups.includes(group)) issues.push({ code: 'dependency-group-disabled', severity: 'warning', message: `依赖的能力组被预设关闭: ${group}` })
    }
  }

  for (const hostClass of manifest?.requires?.hostClasses ?? []) {
    if (!HOST_CONTRACT_CLASSES.includes(hostClass)) issues.push({ code: 'host-class-missing', severity: 'warning', field: 'requires.hostClasses', message: `宿主语义类不存在（清单声明了但宿主没提供）: ${hostClass}` })
  }

  const size = bodyBytes(input.dir)
  if (size > SKILL_BODY_WARN_BYTES) issues.push({ code: 'body-oversize', severity: 'warning', message: `SKILL.md 体积 ${Math.round(size / 1024)} KiB，超过建议上限 ${SKILL_BODY_WARN_BYTES / 1024} KiB` })

  return issues
}

export interface SkillDoctorReport {
  slug: string
  dir: string
  issues: SkillDoctorIssue[]
  counts: Record<SkillDoctorSeverity, number>
}

function countSeverities(issues: readonly SkillDoctorIssue[]): Record<SkillDoctorSeverity, number> {
  const counts: Record<SkillDoctorSeverity, number> = { error: 0, warning: 0, info: 0 }
  for (const issue of issues) counts[issue.severity] += 1
  return counts
}

export function doctorSkill(input: SkillDoctorInput): SkillDoctorReport {
  const issues = diagnoseSkill(input)
  return { slug: input.slug ?? readSkillDescriptor(input.dir, input.slug).descriptor.slug, dir: input.dir, issues, counts: countSeverities(issues) }
}

/** 扫描一个 Skill 根目录（含直接子目录）。清单只读，不写任何文件。 */
export function diagnoseSkillRoot(root: string, options: { toolNames?: readonly string[]; policy?: EffectiveAgentPresetPolicy } = {}): SkillDoctorReport[] {
  if (!existsSync(root)) return []
  const reports: SkillDoctorReport[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    if (!existsSync(join(dir, 'SKILL.md'))) continue
    reports.push(doctorSkill({ dir, slug: entry.name, ...options }))
  }
  return reports.sort((a, b) => a.slug.localeCompare(b.slug))
}

/** 人类可读报告；CLI 与测试共用，避免两处格式漂移。 */
export function formatSkillDoctorReport(reports: readonly SkillDoctorReport[]): string {
  const lines: string[] = []
  for (const report of reports) {
    const { error, warning, info } = report.counts
    lines.push(`${report.slug}：${error} error / ${warning} warning / ${info} info`)
    for (const issue of report.issues) lines.push(`  [${issue.severity}] ${issue.code}${issue.field ? ` (${issue.field})` : ''}: ${issue.message}`)
  }
  const totals = reports.reduce((sum, report) => ({
    error: sum.error + report.counts.error,
    warning: sum.warning + report.counts.warning,
    info: sum.info + report.counts.info,
  }), { error: 0, warning: 0, info: 0 })
  lines.push(`共 ${reports.length} 个 Skill：${totals.error} error / ${totals.warning} warning / ${totals.info} info`)
  return lines.join('\n')
}
