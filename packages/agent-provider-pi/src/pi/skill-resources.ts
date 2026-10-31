/** Pi 的受管 Skill 目录身份、恢复加载与显式引用。 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { LoadSkillsFromDirOptions, ResourceLoader, Skill } from '@earendil-works/pi-coding-agent'
import { normalizeDefaultSkillSlug, normalizeDefaultSkillSlugs } from './skill-slugs'

type SkillLoadResult = ReturnType<ResourceLoader['getSkills']>
type SkillDirectoryLoader = (options: LoadSkillsFromDirOptions) => SkillLoadResult
// SDK 会复制 Skill 对象，symbol 可随 spread 保留，但不会进入 JSON/模型目录。
const labelAlias = Symbol('proferSkillLabel')
type ManagedSkill = Skill & { [labelAlias]?: string }
// 与共享路由相同：标点结束引用，保留冒号/斜杠以完整拒绝 qualified/路径误引用。
const SKILL_COMMAND_PATTERN = /(?:^|\s)\/skill:([^\s<>"'，。；！？、,;!?()\[\]{}“”‘’]+)/g

function guardedRealPath(path: string): string {
  const resolved = resolve(path)
  let existing = resolved
  while (true) {
    try {
      lstatSync(existing)
      return resolve(realpathSync.native(existing), relative(existing, resolved))
    } catch {
      const parent = dirname(existing)
      if (parent === existing) return resolved
      existing = parent
    }
  }
}

function isWithin(path: string, root: string): boolean {
  const tail = relative(root, path)
  return tail === '' || (tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail))
}

function canonicalSlug(skill: Skill): string {
  return normalizeDefaultSkillSlug(basename(skill.baseDir))
}

function diagnostic(message: string): SkillLoadResult['diagnostics'][number] {
  // 不携带原始 SDK message、路径、collision winner/loser，避免泄露禁用资源。
  return { type: 'warning', message }
}

/**
 * undefined 保留所有受管目录；[] 禁止所有；非空仅允许规范目录 slug。
 * 在 override 中逐目录调用 SDK parser，恢复 loadSkills 按 name 去重丢失的项。
 * base 的无盘上文件 fixture 仍可使用两参数同步接口；盘上加载注入已动态 import 的 SDK parser。
 */
export function createProferSkillsOverride(
  additionalSkillPaths: string[] | undefined,
  skillSlugs?: string[],
  loadDirectory?: SkillDirectoryLoader,
): (base: SkillLoadResult) => SkillLoadResult {
  const roots = [...new Set((additionalSkillPaths ?? []).map(guardedRealPath))]
  const normalized = normalizeDefaultSkillSlugs(skillSlugs)
  const allowed = normalized === undefined ? undefined : new Set(normalized)
  const withinRoots = (path: string) => roots.some((root) => isWithin(guardedRealPath(path), root))
  return (base) => {
    if (allowed?.size === 0) return { skills: [], diagnostics: [] }
    const diagnostics: SkillLoadResult['diagnostics'] = base.diagnostics
      .filter((item) => item.type !== 'collision' && (!item.path || withinRoots(item.path)))
      .map(() => diagnostic('Skill 加载时出现可见诊断'))
    const candidates = new Map<string, ManagedSkill>()
    const visited = new Set<string>()
    const attempted = new Set<string>()
    const add = (skill: Skill): void => {
      if (!withinRoots(skill.filePath) || !withinRoots(skill.baseDir)) return
      const slug = canonicalSlug(skill)
      if (allowed && !allowed.has(slug)) return
      const managed: ManagedSkill = { ...skill, name: slug, [labelAlias]: (skill as ManagedSkill)[labelAlias] ?? skill.name }
      candidates.set(guardedRealPath(skill.filePath), managed)
    }
    // 保留同步 synthetic fixture；盘上 parser 的结果随后覆盖相同文件。
    for (const skill of base.skills) add(skill)
    const visit = (path: string): void => {
      const realPath = guardedRealPath(path)
      if (!withinRoots(path) || visited.has(realPath)) return
      visited.add(realPath)
      try {
        const stats = statSync(path)
        const filePath = stats.isDirectory() ? join(path, 'SKILL.md') : path
        if ((stats.isFile() && basename(path) === 'SKILL.md') || existsSync(filePath)) {
          const slug = normalizeDefaultSkillSlug(basename(dirname(filePath)))
          if (allowed && !allowed.has(slug)) return
          if (!withinRoots(filePath)) {
            diagnostics.push(diagnostic('Skill 文件超出受管范围，已安全跳过'))
            return
          }
          const fileRealPath = guardedRealPath(filePath)
          if (attempted.has(fileRealPath)) return
          attempted.add(fileRealPath)
          const result = loadDirectory
            ? loadDirectory({ dir: dirname(filePath), source: 'path' })
            : { skills: base.skills.filter((skill) => guardedRealPath(skill.filePath) === fileRealPath), diagnostics: [] }
          if (loadDirectory) candidates.delete(fileRealPath)
          for (const skill of result.skills) add(skill)
          if (result.diagnostics.length > 0 || result.skills.length === 0) {
            diagnostics.push(diagnostic('允许的 Skill 无法读取或解析，请检查 Skill 文件'))
          }
          return
        }
        if (!stats.isDirectory()) return
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
          if (entry.isDirectory() || entry.isSymbolicLink()) visit(join(path, entry.name))
        }
      } catch {
        diagnostics.push(diagnostic('Skill 目录不存在或不可读，请检查受管 Skill 配置'))
      }
    }
    for (const root of roots) visit(root)
    // slug 必须唯一。历史新旧目录并存时只选规范目录，其他冲突 fail closed。
    const bySlug = new Map<string, ManagedSkill[]>()
    for (const skill of candidates.values()) {
      const matches = bySlug.get(skill.name) ?? []
      matches.push(skill)
      bySlug.set(skill.name, matches)
    }
    const skills: Skill[] = []
    for (const [slug, matches] of bySlug) {
      const current = matches.filter((skill) => basename(skill.baseDir) === slug)
      const canonical = current.length > 0 ? current : matches
      if (canonical.length === 1) skills.push(canonical[0]!)
      else diagnostics.push(diagnostic('Skill 目录 slug 有多个匹配项，已安全跳过'))
    }
    if (allowed && [...allowed].some((slug) => !bySlug.has(slug))) {
      diagnostics.push(diagnostic('部分白名单 Skill 不存在、不可读或不是规范目录 slug，已安全跳过'))
    }
    return { skills, diagnostics }
  }
}

function resolveReference(skills: Skill[], requested: string): { skill?: Skill; message?: string } {
  const normalized = normalizeDefaultSkillSlug(requested)
  const canonical = skills.filter((skill) => canonicalSlug(skill) === normalized)
  const matches = canonical.length > 0 ? canonical : skills.filter((skill) => {
    const label = (skill as ManagedSkill)[labelAlias] ?? skill.name
    return normalizeDefaultSkillSlug(label) === normalized
  })
  if (matches.length === 1) return { skill: matches[0] }
  return { message: matches.length > 1
    ? 'Skill 引用有多个匹配项，请使用规范目录 slug，已安全跳过'
    : 'Skill 引用不存在、不可读或未获允许，已安全跳过' }
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** SDK steer/followUp 没有禁用 Skill 展开的参数；保留原文，避开 startsWith 命令分支。 */
export function preparePromptForPiSkillQueue(prompt: string): string {
  return prompt.startsWith('/skill:') ? `\n${prompt}` : prompt
}

/** [] 显式不引用；只有 undefined 才保留 direct adapter 的旧 prompt 扫描行为。 */
export async function preparePromptWithProferSkills(resourceLoader: ResourceLoader, prompt: string, explicitSkillNames?: string[]): Promise<string> {
  const names = explicitSkillNames ?? [...prompt.matchAll(SKILL_COMMAND_PATTERN)].map((match) => match[1]!)
  if (names.length === 0) return prompt
  try {
    await resourceLoader.reload()
  } catch {
    return `[Skill 引用诊断] Skill 目录加载失败，已安全跳过\n\n${prompt}`
  }
  const skills = resourceLoader.getSkills().skills
  const blocks: string[] = []
  const messages = new Set<string>()
  const injected = new Set<string>()
  for (const name of names) {
    const { skill, message } = resolveReference(skills, name)
    if (!skill) {
      if (message) messages.add(message)
      continue
    }
    const key = guardedRealPath(skill.filePath)
    if (injected.has(key)) continue
    try {
      const content = readFileSync(skill.filePath, 'utf-8').replace(/^\uFEFF/, '')
      const body = content.replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/, '').trim()
      blocks.push(`<skill name="${escapeXml(canonicalSlug(skill))}" location="${escapeXml(skill.filePath)}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`)
      injected.add(key)
    } catch {
      messages.add('Skill 引用文件不可读，已安全跳过')
    }
  }
  if (messages.size > 0) blocks.push(`[Skill 引用诊断] ${[...messages].join('；')}`)
  return blocks.length > 0 ? `${blocks.join('\n\n')}\n\n${prompt}` : prompt
}
