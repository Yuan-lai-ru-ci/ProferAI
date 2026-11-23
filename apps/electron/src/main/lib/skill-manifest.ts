/**
 * Skill 模块清单（SKILL.json）读取与元数据优先级。
 *
 * 优先级：模块清单 > 正文 frontmatter。清单缺失时不阻断加载；展示字段损坏只产出诊断，
 * 门禁字段（依赖、策略）损坏由 skillManifestGateInvalid 交给路由拦截。
 * 本文件是 main 进程里唯一决定「元数据从哪来」的地方，config-paths / global-skill-manager / skill-routing 共用它，避免三份解析漂移。
 */
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative } from 'node:path'
import {
  parseSkillManifest,
  SKILL_MANIFEST_FILENAME,
  SKILL_MANIFEST_SCHEMA_VERSION,
  skillManifestDescription,
  skillManifestDisplayName,
  type SkillManifest,
  type SkillManifestIssue,
  type SkillManifestPatch,
} from '@profer/shared'
import { writeJsonFileAtomic } from './safe-file'

export * from '@profer/agent-provider-pi/skills/skill-manifest'
import { readSkillManifest } from '@profer/agent-provider-pi/skills/skill-manifest'

/**
 * 写入补丁类型定义在 `@profer/shared`（IPC / 渲染层要引用）；此处只保留磁盘语义说明。
 * `undefined` 不动字段，`null` / 空值删字段，其他值覆盖。
 */
export interface SkillManifestWriteResult {
  path: string
  /** 补丁把卡片写成了空内容，文件已被删除。 */
  removed: boolean
  manifest?: SkillManifest
  /** 校验产生的提示；error 级问题会直接报错不落盘，不会出现在这里。 */
  issues: SkillManifestIssue[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 需要逐字段合并的对象组；其余顶层字段整值覆盖。 */
const MANIFEST_GROUPS = ['interface', 'policy', 'triggers', 'dependencies', 'requires'] as const

/** 字符串数组归一化：去空白、去空项、去重；非字符串项原样交给校验器报错。 */
function normalizeList(value: readonly unknown[]): unknown[] {
  const seen = new Set<string>()
  const result: unknown[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      result.push(item)
      continue
    }
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

/** 把一组字段合并进目标对象：null / 空数组 → 删字段，undefined → 不动。 */
function mergeGroup(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const normalized = Array.isArray(value) ? normalizeList(value) : value
    // 空字符串 / 空数组 / null 都是“删掉这个字段”，让 UI 清空输入框就能回到未声明状态。
    if (normalized === null || normalized === '' || (Array.isArray(normalized) && normalized.length === 0)) {
      delete target[key]
      continue
    }
    target[key] = normalized
  }
}

/** 读原始 JSON（保留未知字段）；不存在返回空对象，坏 JSON 报错而不静默覆盖。 */
function readRawManifestFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${SKILL_MANIFEST_FILENAME} 不是合法 JSON，已拒绝覆盖；请先修复或删除该文件`)
  }
  if (!isRecord(parsed)) throw new Error(`${SKILL_MANIFEST_FILENAME} 顶层应为对象，已拒绝覆盖`)
  return parsed
}

function isEmptyManifest(record: Record<string, unknown>): boolean {
  return Object.keys(record).every(key => key === 'schemaVersion')
}

/**
 * 合并写入模块清单：保留未知字段，先校验后落盘，校验不过就原样报错不写。
 * 清空已配置的卡片会删除文件；直接保存默认卡片则保留它。
 */
export function writeSkillManifest(dir: string, patch: SkillManifestPatch): SkillManifestWriteResult {
  const path = join(dir, SKILL_MANIFEST_FILENAME)
  const merged = readRawManifestFile(path)
  const keepDefault = merged.schemaVersion === SKILL_MANIFEST_SCHEMA_VERSION && isEmptyManifest(merged)
  merged.schemaVersion = SKILL_MANIFEST_SCHEMA_VERSION
  // 先处理顶层标量（含 provenance），再逐组合并：分组不能被整份覆盖，否则磁盘上没在补丁里出现的字段会丢。
  for (const [key, value] of Object.entries(patch)) {
    if ((MANIFEST_GROUPS as readonly string[]).includes(key)) continue
    if (value === undefined) continue
    if (value === null || value === '') {
      delete merged[key]
      continue
    }
    merged[key] = value
  }
  for (const group of MANIFEST_GROUPS) {
    const groupPatch = patch[group]
    if (groupPatch === undefined) continue
    if (groupPatch === null) {
      delete merged[group]
      continue
    }
    if (!isRecord(groupPatch)) continue
    if (!isRecord(merged[group])) merged[group] = {}
    mergeGroup(merged[group] as Record<string, unknown>, groupPatch)
    if (Object.keys(merged[group] as Record<string, unknown>).length === 0) delete merged[group]
  }

  const parsed = parseSkillManifest(merged)
  const errors = parsed.issues.filter(issue => issue.severity === 'error')
  if (errors.length > 0 || !parsed.manifest) {
    throw new Error(`${SKILL_MANIFEST_FILENAME} 校验未通过：${errors.map(issue => issue.message).join('；') || '内容不可用'}`)
  }
  const issues = parsed.issues.filter(issue => issue.severity !== 'error')

  if (isEmptyManifest(merged) && !keepDefault) {
    if (existsSync(path)) rmSync(path, { force: true })
    return { path, removed: true, issues }
  }
  // 不生成 .bak：卡片目录会被复制/投影，备份文件只会成为噪音；正文里的名称/描述仍是兜底。
  writeJsonFileAtomic(path, merged, true)
  const written = readSkillManifest(dir)
  return { path, removed: false, manifest: written.manifest ?? parsed.manifest, issues: [...issues, ...written.issues.filter(issue => issue.severity !== 'error')] }
}

/** 删除卡片（回到“没卡片”状态）；不存在时幂等返回。 */
export function clearSkillManifest(dir: string): SkillManifestWriteResult {
  const path = join(dir, SKILL_MANIFEST_FILENAME)
  if (existsSync(path)) rmSync(path, { force: true })
  return { path, removed: true, issues: [] }
}
