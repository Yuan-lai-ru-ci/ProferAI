/**
 * Skill 模块清单（SKILL.json）读取与元数据优先级。
 *
 * 优先级：模块清单 > 正文 frontmatter。清单缺失或损坏时不阻断加载，只产出诊断
 * （Skill 不能被清单问题挡在门外）；本文件是 main 进程里唯一决定「元数据从哪来」
 * 的地方，config-paths / global-skill-manager / skill-routing 共用它，避免三份解析漂移。
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

export { SKILL_MANIFEST_FILENAME }

/** 清单体积上限；远小于正文，避免把清单当数据文件用。 */
export const MAX_SKILL_MANIFEST_BYTES = 32 * 1024

export interface SkillManifestReadResult {
  manifest?: SkillManifest
  issues: SkillManifestIssue[]
  /** 清单文件是否真的存在：区分「没写」与「写了但坏了」。 */
  present: boolean
}

function manifestInvalid(message: string, field?: string): SkillManifestReadResult {
  return { issues: [{ code: 'invalid-field', severity: 'error', ...(field ? { field } : {}), message }], present: true }
}

/**
 * 读取并校验清单。不存在返回空结果；路径越界、超预算、JSON 损坏都只返回 issue。
 */
export function readSkillManifest(dir: string): SkillManifestReadResult {
  const path = join(dir, SKILL_MANIFEST_FILENAME)
  if (!existsSync(path)) return { issues: [], present: false }
  try {
    const realDir = realpathSync(dir)
    const real = realpathSync(path)
    const rel = relative(realDir, real)
    // 软链越界的清单等同于不存在，绝不让清单把宿主指向 Skill 目录之外。
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) {
      return { issues: [{ code: 'unsafe-path', severity: 'error', field: SKILL_MANIFEST_FILENAME, message: 'SKILL.json 越出 Skill 目录' }], present: true }
    }
    if (statSync(real).size > MAX_SKILL_MANIFEST_BYTES) return manifestInvalid(`SKILL.json 超过 ${MAX_SKILL_MANIFEST_BYTES} 字节`, SKILL_MANIFEST_FILENAME)
    const parsed = parseSkillManifest(JSON.parse(readFileSync(real, 'utf8')))
    return { manifest: parsed.manifest, issues: parsed.issues, present: true }
  } catch (error) {
    return manifestInvalid(`SKILL.json 无法解析: ${error instanceof Error ? error.message : String(error)}`, SKILL_MANIFEST_FILENAME)
  }
}

export interface SkillFrontmatterFields {
  name?: string
  description?: string
  version?: string
}

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[^\S\r\n]*(?:\r?\n|$)/
const FRONTMATTER_FIELDS = ['name', 'description', 'version'] as const

/**
 * 最小 frontmatter 读取：只取 name / description / version 三个标量。
 * 支持行内值与块标量（`|` / `>`），否则会把 `description: >` 读成一个字符（历史 bug）。
 * 正文解析仍归 SDK（skill-routing 需要 body 与 disable-model-invocation），
 * 这里只服务于版本比较与元数据回退。
 */
export function readSkillFrontmatterFields(dir: string): SkillFrontmatterFields {
  const file = join(dir, 'SKILL.md')
  if (!existsSync(file)) return {}
  try {
    const content = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const block = content.match(FRONTMATTER_BLOCK)?.[1]
    if (!block) return {}
    const fields: SkillFrontmatterFields = {}
    const lines = block.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!
      // 只认顶层标量行，缩进行属于嵌套结构或上一个块标量，不在这里单独解析。
      if (!line || /^\s/.test(line)) continue
      const colon = line.indexOf(':')
      if (colon < 0) continue
      const key = line.slice(0, colon).trim()
      if (!(FRONTMATTER_FIELDS as readonly string[]).includes(key)) continue
      const raw = line.slice(colon + 1).trim()
      const scalar = raw.match(/^([|>])[+-]?\d*$/)
      if (scalar) {
        // 块标量：收拢后续缩进行；`>` 折成空格，`|` 保留换行。
        const folded = scalar[1] === '>'
        const collected: string[] = []
        let next = index + 1
        for (; next < lines.length; next += 1) {
          const candidate = lines[next]!
          if (candidate.trim() === '') { collected.push(''); continue }
          if (!/^\s/.test(candidate)) break
          collected.push(candidate.trim())
        }
        index = next - 1
        const value = (folded ? collected.join(' ') : collected.join('\n')).trim()
        if (value) fields[key as (typeof FRONTMATTER_FIELDS)[number]] = value
        continue
      }
      const value = raw.replace(/^['"]|['"]$/g, '')
      if (value) fields[key as (typeof FRONTMATTER_FIELDS)[number]] = value
    }
    return fields
  } catch {
    return {}
  }
}

export interface SkillDescriptor {
  /** 目录名即权威 slug：清单只能声明，不能改变存放位置。 */
  slug: string
  /** 清单里声明的 slug（用于 doctor 报不一致），未声明时为空。 */
  declaredSlug?: string
  name: string
  /** 展示名：interface.displayName > name。 */
  displayName: string
  description: string
  version: string
  /** 字段来源，供 doctor 报「清单与 frontmatter 不一致」。 */
  sources: {
    name: 'manifest' | 'frontmatter' | 'directory'
    description: 'manifest' | 'frontmatter' | 'none'
    version: 'manifest' | 'frontmatter' | 'default'
  }
}

/** 纯优先级计算：清单优先、frontmatter 回退，不做磁盘判断。 */
export function resolveSkillDescriptor(input: { dirName: string; manifest?: SkillManifest; frontmatter?: SkillFrontmatterFields }): SkillDescriptor {
  const { dirName, manifest, frontmatter } = input
  const manifestName = manifest?.name
  const frontmatterName = frontmatter?.name
  const name = manifestName ?? frontmatterName ?? dirName
  const description = skillManifestDescription(manifest) ?? frontmatter?.description ?? ''
  const version = manifest?.version ?? frontmatter?.version ?? '0.0.0'
  return {
    slug: dirName,
    ...(manifest?.slug ? { declaredSlug: manifest.slug } : {}),
    name,
    displayName: skillManifestDisplayName(manifest) ?? name,
    description,
    version,
    sources: {
      name: manifestName ? 'manifest' : (frontmatterName ? 'frontmatter' : 'directory'),
      description: skillManifestDescription(manifest) !== undefined ? 'manifest' : (frontmatter?.description ? 'frontmatter' : 'none'),
      version: manifest?.version ? 'manifest' : (frontmatter?.version ? 'frontmatter' : 'default'),
    },
  }
}

export interface SkillDescriptorReadResult {  descriptor: SkillDescriptor
  manifest?: SkillManifest
  manifestIssues: SkillManifestIssue[]
  manifestPresent: boolean
  frontmatter: SkillFrontmatterFields
}

/** 磁盘入口：读清单 + 读 frontmatter，按优先级合成描述符。 */
export function readSkillDescriptor(dir: string, dirName = basename(dir)): SkillDescriptorReadResult {
  const manifestRead = readSkillManifest(dir)
  const frontmatter = readSkillFrontmatterFields(dir)
  return {
    descriptor: resolveSkillDescriptor({ dirName, manifest: manifestRead.manifest, frontmatter }),
    manifest: manifestRead.manifest,
    manifestIssues: manifestRead.issues,
    manifestPresent: manifestRead.present,
    frontmatter,
  }
}

/**
 * 版本解析（供 config-paths 的种子升级与工作区副本记录使用）：
 * 清单版本 > frontmatter 版本 > '0.0.0'（保证旧 Skill 会被更新）。
 */
export function readSkillVersion(dir: string): string {
  return readSkillDescriptor(dir).descriptor.version
}

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
 * 卡片被写成空内容时删除文件，回到 frontmatter / 侧车回退路径。
 */
export function writeSkillManifest(dir: string, patch: SkillManifestPatch): SkillManifestWriteResult {
  const path = join(dir, SKILL_MANIFEST_FILENAME)
  const merged = readRawManifestFile(path)
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

  if (isEmptyManifest(merged)) {
    if (existsSync(path)) rmSync(path, { force: true })
    return { path, removed: true, issues }
  }
  // 不生成 .bak：卡片目录会被复制/投影，备份文件只会成为噪音；正文里的名称/描述仍是兵底。
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
