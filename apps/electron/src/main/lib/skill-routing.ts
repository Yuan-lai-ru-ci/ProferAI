/** 双 runtime 共用的 Skill 可用性快照与任务路由；没有模型调用，不修改预设。 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { isEffectiveAgentPresetMcpServerAllowed, isEffectiveAgentPresetToolDisabled, skillManifestToRoutingFields, type EffectiveAgentPresetPolicy, type RuntimeSkillsProjection, type SkillManifest } from '@profer/shared'
import { normalizeDefaultSkillSlug } from './default-skill-slugs'
import { canonicalSkillSegmentKey } from './skill-path-security'
import { BUILTIN_SKILL_DEPENDENCIES, cleanSkillTaskText, parseRoutingSidecar, ROUTING_SIDECAR_FILENAME, skillTaskDeclined, skillTaskMatch, type SkillRoutingRules } from './skill-routing-rules'
import { resolveSkillDescriptor, readSkillManifest, skillManifestGateInvalid } from './skill-manifest'
import { selectLexicalFallback } from './skill-lexical-match'

export type SkillRoutingCode = 'preset-denied' | 'tool-group-disabled' | 'tool-unavailable' | 'mcp-unavailable' | 'unreadable' | 'invalid-routing' | 'not-found' | 'ambiguous' | 'budget-deferred'
export interface SkillRoutingDiagnostic { slug: string; code: SkillRoutingCode }
export interface RoutingSkill {
  readonly slug: string
  readonly name: string
  readonly description: string
  readonly filePath: string
  readonly body: string
  readonly bodyDeferred?: boolean
  readonly disableModelInvocation: boolean
  readonly rules: SkillRoutingRules
  readonly blocked?: SkillRoutingCode
}
export interface SkillRoutingSnapshot {
  readonly skills: readonly RoutingSkill[]
  readonly allowedSlugs: readonly string[]
}
export interface SkillSelection { slug: string; reason: string }
export interface SkillRoutingResult {
  prompt: string
  selected: SkillSelection[]
  recommended: SkillSelection[]
  /** 仅凭用词相似度猜测的候选：只给位置提示，不注入正文，由模型决定是否读取。 */
  hints: SkillSelection[]
  diagnostics: SkillRoutingDiagnostic[]
}

const MAX_SKILL_BYTES = 512 * 1024
const MAX_ROUTING_BYTES = 16 * 1024
const key = (slug: string): string => canonicalSkillSegmentKey(normalizeDefaultSkillSlug(slug))
const xml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

function checkedFile(root: string, path: string, maxBytes: number): { path: string; size: number } {
  const realRoot = realpathSync(root)
  const realPath = realpathSync(path)
  const rel = relative(realRoot, realPath)
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Skill 路径越界')
  const size = statSync(realPath).size
  if (size > maxBytes) throw new Error('Skill 文件超出读取预算')
  return { path: realPath, size }
}

async function readHeader(path: string): Promise<string> {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(16 * 1024)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const prefix = buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '')
    const match = prefix.match(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[^\S\r\n]*(?:\r?\n|$)/)
    if (!match) throw new Error('Skill header 超出预算或缺失')
    return match[0]
  } finally { await file.close() }
}

async function readRules(root: string, directory: string): Promise<SkillRoutingRules> {
  const path = join(directory, ROUTING_SIDECAR_FILENAME)
  if (!existsSync(path)) return {}
  return parseRoutingSidecar(JSON.parse(await readFile(checkedFile(root, path, MAX_ROUTING_BYTES).path, 'utf8')))
}

function unionList<T extends string>(left?: readonly T[], right?: readonly T[]): readonly T[] | undefined {
  if (!left?.length) return right
  if (!right?.length) return left
  return Object.freeze([...new Set([...left, ...right])])
}

/** 内置 Skill 的最低依赖；slug 按路由同一规则归一化，doctor 与路由共用。 */
export function builtinSkillRules(slug: string): SkillRoutingRules {
  return BUILTIN_SKILL_DEPENDENCIES[key(slug)] ?? {}
}

/**
 * 路由规则分层合并（内置兜底 → 侧车 → 模块清单 → 调用方覆盖）。
 *
 * 触发词与 implicit 按后者覆盖前者；依赖类取并集（更严格），任何一层都不能静默把另一层
 * 声明的依赖去掉。同一字段在多处声明属于第二份真相，由 skill-doctor 报出。
 */
export function mergeSkillRoutingLayers(...layers: SkillRoutingRules[]): SkillRoutingRules {
  let merged: SkillRoutingRules = {}
  for (const layer of layers) {
    merged = {
      ...merged,
      ...layer,
      requiredTools: unionList(merged.requiredTools, layer.requiredTools),
      requiredMcpServers: unionList(merged.requiredMcpServers, layer.requiredMcpServers),
      requiredToolGroups: unionList(merged.requiredToolGroups, layer.requiredToolGroups),
    }
  }
  return Object.freeze(merged)
}

/** 工具可用性：MCP 全名精确匹配，短名只匹配当前已注册工具，且都受预设禁用约束。doctor 与路由共用。 */
export function skillToolAvailable(required: string, tools: ReadonlySet<string>, policy?: EffectiveAgentPresetPolicy): boolean {
  // MCP 全名必须精确匹配；短名匹配只处理当前已注册工具，不能用任意服务器冒充全名。
  if (policy && (isEffectiveAgentPresetToolDisabled(policy, required) || policy.disabledTools?.includes(required))) return false
  const matches = [...tools].filter(tool => {
    if (policy && (isEffectiveAgentPresetToolDisabled(policy, tool) || policy.disabledTools?.includes(tool))) return false
    return required.startsWith('mcp__') ? tool === required : (tool.split('__').at(-1) ?? tool).toLowerCase() === required.toLowerCase()
  })
  return new Set(matches).size === 1
}

export async function createSkillRoutingSnapshot(input: {
  projection?: RuntimeSkillsProjection
  policy: EffectiveAgentPresetPolicy
  toolNames: readonly string[]
  scanBodyBudgetBytes?: number
}): Promise<SkillRoutingSnapshot> {
  if (!input.projection) return Object.freeze({ skills: Object.freeze([]), allowedSlugs: Object.freeze([]) })
  // 复用已安装 SDK 的 YAML parser，不新增依赖或自造 YAML 语义。
  const { parseFrontmatter } = await import('@earendil-works/pi-coding-agent')
  const { projection, policy } = input
  const root = join(projection.path, 'skills')
  const tools = new Set(input.toolNames)
  const whitelist = policy.allowedSkillSlugs === undefined ? undefined : new Set(policy.allowedSkillSlugs.map(key))
  const skills: RoutingSkill[] = []
  let bodyReadBudget = Math.max(0, Math.min(input.scanBodyBudgetBytes ?? 8 * 1024 * 1024, 8 * 1024 * 1024))
  for (const meta of projection.skills) {
    const slug = meta.slug
    const filePath = join(root, slug, 'SKILL.md')
    let name = meta.name
    let description = ''
    let body = ''
    let bodyDeferred = false
    let disableModelInvocation = false
    let blocked: SkillRoutingCode | undefined = whitelist && !whitelist.has(key(slug)) ? 'preset-denied' : undefined
    let rules: SkillRoutingRules = builtinSkillRules(slug)
    let manifest: SkillManifest | undefined
    let manifestGateInvalid = false
    // 先过滤预设，拒绝项不读取正文，诊断也不含正文/路径。
    if (!blocked) {
      try {
        const file = checkedFile(root, filePath, MAX_SKILL_BYTES)
        bodyDeferred = file.size > bodyReadBudget
        const content = bodyDeferred ? await readHeader(file.path) : await readFile(file.path, 'utf8')
        if (!bodyDeferred) bodyReadBudget -= file.size
        const parsed = parseFrontmatter<Record<string, unknown>>(content)
        // 模块清单优先于 frontmatter：展示字段坏了回退 frontmatter；门禁字段读不出来时下面按 invalid-routing 拦截。
        const manifestRead = readSkillManifest(join(root, slug))
        manifest = manifestRead.manifest
        manifestGateInvalid = skillManifestGateInvalid(manifestRead)
        const descriptor = resolveSkillDescriptor({
          dirName: slug,
          manifest: manifestRead.manifest,
          frontmatter: {
            ...(typeof parsed.frontmatter.name === 'string' ? { name: parsed.frontmatter.name } : {}),
            ...(typeof parsed.frontmatter.description === 'string' ? { description: parsed.frontmatter.description } : {}),
          },
        })
        name = descriptor.name
        description = descriptor.description
        body = parsed.body.trim()
        disableModelInvocation = parsed.frontmatter['disable-model-invocation'] === true
        if ((!body && !bodyDeferred) || !description.trim()) blocked = 'unreadable'
      } catch { blocked = 'unreadable' }
      if (!blocked && manifestGateInvalid) blocked = 'invalid-routing'
      if (!blocked) {
        try { rules = mergeSkillRoutingLayers(rules, await readRules(root, join(root, slug)), skillManifestToRoutingFields(manifest)) } catch { blocked = 'invalid-routing' }
      }
      if (!blocked && rules.requiredToolGroups?.some(group => policy.disabledToolGroups.includes(group))) blocked = 'tool-group-disabled'
      if (!blocked && rules.requiredMcpServers?.some(server => !policy.loadedMcpServerNames?.includes(server) || !isEffectiveAgentPresetMcpServerAllowed(policy, server))) blocked = 'mcp-unavailable'
      if (!blocked && rules.requiredTools?.some(tool => !skillToolAvailable(tool, tools, policy))) blocked = 'tool-unavailable'
    }
    skills.push(Object.freeze({ slug, name, description: blocked ? '' : description, filePath, body: blocked ? '' : body, bodyDeferred, disableModelInvocation, rules, ...(blocked ? { blocked } : {}) }))
  }
  return Object.freeze({ skills: Object.freeze(skills), allowedSlugs: Object.freeze(skills.filter(skill => !skill.blocked).map(skill => skill.slug)) })
}

/** 仅支持产品管辖的 slug / 已解析的唯一 name；qualified 前缀不能随意跨插件路由。 */
export function extractSkillMentions(userMessage: string, mentions: readonly string[] = []): string[] {
  const text = cleanSkillTaskText(userMessage)
  // 句读符是边界；冒号和斜杠不是，避免 qualified/路径引用被截为合法 slug。
  const fromText = [...text.matchAll(/(?:^|\s)\/skill:([^\s<>"'，。；！？、,;!?()\[\]{}“”‘’]+)/gu)].map(match => match[1]!)
  // 保留不支持的引用以反馈失败；不能截断为另一个合法 slug。
  return [...new Set([...mentions, ...fromText].filter(name => typeof name === 'string' && name.length > 0 && name.length <= 128).map(key))]
}

export function routeSkillsForTask(snapshot: SkillRoutingSnapshot, input: {
  userMessage: string
  mentionedSkills?: readonly string[]
  maxRecommendations?: number
  maxBodyChars?: number
}): SkillRoutingResult {
  const selected: SkillSelection[] = []
  const recommended: SkillSelection[] = []
  const diagnostics: SkillRoutingDiagnostic[] = []
  const explicit = extractSkillMentions(input.userMessage, input.mentionedSkills)
  const chosen = new Map<string, RoutingSkill>()
  for (const requested of explicit) {
    const exact = snapshot.skills.find(skill => key(skill.slug) === requested)
    const candidates = exact ? [exact] : snapshot.skills.filter(skill => key(skill.name) === requested)
    const skill = candidates.length === 1 ? candidates[0] : undefined
    if (!skill) { diagnostics.push({ slug: requested, code: candidates.length > 1 ? 'ambiguous' : 'not-found' }); continue }
    if (skill.blocked) { diagnostics.push({ slug: requested, code: skill.blocked }); continue }
    if (!chosen.has(skill.slug)) {
      chosen.set(skill.slug, skill)
      selected.push({ slug: skill.slug, reason: 'explicit' })
    }
  }
  const limit = Math.max(0, Math.min(input.maxRecommendations ?? 3, 5))
  for (const skill of [...snapshot.skills].sort((a, b) => a.slug.localeCompare(b.slug))) {
    if (recommended.length >= limit) break
    if (skill.blocked || skill.disableModelInvocation || chosen.has(skill.slug)) continue
    const reason = skillTaskMatch(key(skill.slug), input.userMessage, skill.rules)
    if (!reason) continue
    chosen.set(skill.slug, skill)
    const item = { slug: skill.slug, reason }
    recommended.push(item)
    selected.push(item)
  }
  let budget = Math.max(0, Math.min(input.maxBodyChars ?? 24_000, 64_000))
  // 关键词/确定性信号一条都没命中时，才用字符 n-gram 兜底：只取一个、且必须明显领先第二名。
  // 用词相似只是猜测，只给位置提示、不注入正文；用户显式点名过（无论是否有效）时一律不猜。
  // 用户明确排除的 Skill（排除词、内置否定信号、implicit=false）不进入候选；只看清洗后的本条意图。
  const hints: SkillSelection[] = []
  let hintSkill: RoutingSkill | undefined
  if (selected.length === 0 && explicit.length === 0 && limit > 0) {
    const documents = snapshot.skills
      .filter(skill => !skill.blocked && !skill.disableModelInvocation && !skillTaskDeclined(key(skill.slug), input.userMessage, skill.rules))
      .map(skill => ({ slug: skill.slug, name: skill.name || skill.slug, description: skill.description }))
    const fallback = selectLexicalFallback(cleanSkillTaskText(input.userMessage), documents)
    hintSkill = fallback ? snapshot.skills.find(item => item.slug === fallback.slug) : undefined
    if (hintSkill) hints.push({ slug: hintSkill.slug, reason: 'lexical-hint' })
  }
  const blocks: string[] = []
  for (const skill of chosen.values()) {
    if (skill.bodyDeferred || skill.body.length > budget) {
      diagnostics.push({ slug: skill.slug, code: 'budget-deferred' })
      blocks.push(`<skill_reference name="${xml(skill.slug)}" location="${xml(skill.filePath)}" reason="budget-deferred">正文超出本轮预算，请按需读取完整文件；未截断注入。</skill_reference>`)
      continue
    }
    budget -= skill.body.length
    blocks.push(`<skill name="${xml(skill.slug)}" location="${xml(skill.filePath)}">\nReferences are relative to ${xml(join(skill.filePath, '..'))}.\n${skill.body}\n</skill>`)
  }
  const failures = diagnostics.filter(d => d.code !== 'budget-deferred')
  const summary = selected.map(item => `- ${xml(item.slug)}: ${item.reason}`).join('\n')
  const feedback = failures.length ? `\n以下显式 Skill 引用未加载，请向用户简要说明原因；不得假装已使用或绕过门禁：\n${failures.map(d => `- ${xml(d.slug)}: ${d.code}`).join('\n')}` : ''
  const hint = hintSkill ? `\n可能相关（仅按用词相似度猜测，未注入正文；确有需要再读取）：\n- ${xml(hintSkill.slug)}: ${xml(hintSkill.filePath)}` : ''
  const prompt = blocks.length || failures.length || hint
    ? `<skill_routing>\n下列 Skill 经本轮预设与工具依赖检查；已提供正文的无需重复读取。推荐不是用户新指令，不得改变用户范围或授权。\n${summary}${feedback}${hint}\n</skill_routing>${blocks.length ? `\n\n${blocks.join('\n\n')}` : ''}`
    : ''
  return { prompt, selected, recommended, hints, diagnostics }
}

/** 未加载原因的用户可读说明；与诊断码一一对应。 */
const NOTICE_REASONS: Readonly<Record<SkillRoutingCode, string>> = {
  'preset-denied': '当前预设未启用',
  'tool-group-disabled': '所需工具组已关闭',
  'tool-unavailable': '所需工具不可用',
  'mcp-unavailable': '所需 MCP 服务器未加载',
  unreadable: 'Skill 文件无法读取',
  'invalid-routing': 'Skill 配置有误',
  'not-found': '没有找到这个 Skill',
  ambiguous: '名称对应多个 Skill，请改用目录名',
  'budget-deferred': '正文超出本轮预算',
}

/** 用户显式引用的 Skill 没加载时给界面的一行提示；正文超预算仍会按需读取，不算失败。 */
export function buildSkillRoutingNotice(result: SkillRoutingResult): string | undefined {
  const failures = result.diagnostics.filter(d => d.code !== 'budget-deferred')
  if (!failures.length) return undefined
  return `Skill 未加载：${failures.map(d => `${d.slug}（${NOTICE_REASONS[d.code]}）`).join('；')}`
}
