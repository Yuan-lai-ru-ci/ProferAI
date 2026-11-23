/**
 * Skill 模块清单（SKILL.json）读取与元数据优先级。
 *
 * 优先级：模块清单 > 正文 frontmatter。清单缺失时不阻断加载；展示字段损坏只产出诊断，
 * 门禁字段（依赖、策略）损坏由 skillManifestGateInvalid 交给路由拦截。
 * 本文件是 main 进程里唯一决定「元数据从哪来」的地方，config-paths / global-skill-manager / skill-routing 共用它，避免三份解析漂移。
 */
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
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


export { SKILL_MANIFEST_FILENAME }

/** 缺卡提醒只针对缺文件；损坏的卡片应由诊断提示，不应被默认卡覆盖。 */
export function hasSkillCard(dir: string): boolean {
  return lstatSync(join(dir, SKILL_MANIFEST_FILENAME), { throwIfNoEntry: false }) !== undefined
}

/** 仅在没有卡片时创建；默认卡不覆盖正文描述，也不改变原有触发或依赖。 */
export function ensureSkillCard(dir: string): void {
  try {
    writeFileSync(join(dir, SKILL_MANIFEST_FILENAME), `${JSON.stringify({ schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION }, null, 2)}\n`, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** 用户的提醒选择不是技能本体，不随复制、导出或运行投影传播。 */
export const SKILL_CARD_DISMISSALS_FILE = 'skill-card-dismissals.json'

export function skillCardDismissalKey(scope: 'global' | 'workspace', id: string, workspaceSlug?: string): string {
  return JSON.stringify(scope === 'global' ? [scope, id] : [scope, workspaceSlug, id])
}

export function readSkillCardDismissals(configDir: string): Set<string> {
  const path = join(configDir, SKILL_CARD_DISMISSALS_FILE)
  try {
    const stored: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(stored) || !stored.every(key => typeof key === 'string')) throw new Error('Skill 路由卡片提醒记录无效')
    return new Set(stored)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw error
  }
}

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
  try {
    if (!hasSkillCard(dir)) return { issues: [], present: false }
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

/**
 * 门禁字段（依赖、策略）是否读不出来：清单存在却整份不可用，或这些字段校验失败。
 *
 * 展示字段坏了可以回退 frontmatter，门禁字段不行——读不出依赖不等于没有依赖，
 * 路由据此按 invalid-routing 拦截（与侧车 profer-routing.json 出错时一致）。
 */
export function skillManifestGateInvalid(read: SkillManifestReadResult): boolean {
  if (!read.present) return false
  if (!read.manifest) return true
  return read.issues.some(issue => issue.severity === 'error' && /^(?:dependencies|policy)(?:\.|$)/.test(issue.field ?? ''))
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

export interface SkillDescriptorReadResult {
  descriptor: SkillDescriptor
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
