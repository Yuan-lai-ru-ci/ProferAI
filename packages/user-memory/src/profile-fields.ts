/**
 * 「我的画像」首屏快速字段 ⇄ 全局记忆 Markdown 的双向映射。
 *
 * 设计约束：
 * - 不新增持久化文件、不改 IPC / 主进程契约；字段写进既有的
 *   `user-profile.md` / `preferences.md`，用可读的二级标题小节承载。
 * - 用户可能已在文件管理器里手写过同名小节（含 bullet、多行正文、注释）。
 *   因此按「行级」读写：只替换小节的第一个值行，其余内容逐行原样保留，
 *   绝不静默丢弃用户已有内容。
 * - 字段值统一为单行；纯函数，无 DOM / IPC / node:fs 依赖，可独立测试。
 *
 * 位置说明：本文件是唯一实现。Electron 的「我的画像」界面与 profer CLI 的
 * `profile get/set` 都从这里导入，保证两边写出的 Markdown 结构完全一致。
 * 因为不依赖 node:fs，renderer 可以直接 import `@profer/user-memory/profile-fields`。
 */

/** 首屏可直接填写的字段。title 同时是 Markdown 二级标题文本。 */
export const QUICK_FIELDS = [
  {
    key: 'address',
    title: '称呼',
    label: '怎么称呼你',
    hint: 'Agent 在回复里如何称呼你',
    placeholder: '例如：源来如此 / 老源',
    file: 'user-profile.md',
  },
  {
    key: 'role',
    title: '职业与领域',
    label: '职业与领域',
    hint: '让 Agent 更快理解问题背景',
    placeholder: '例如：独立开发者 · 桌面应用 / AI 工具',
    file: 'user-profile.md',
  },
  {
    key: 'language',
    title: '常用语言',
    label: '常用语言',
    hint: '默认回复语言与术语习惯',
    placeholder: '例如：中文，技术术语保留英文',
    file: 'user-profile.md',
  },
  {
    key: 'collaboration',
    title: '协作偏好',
    label: '协作偏好',
    hint: '你希望 Agent 怎么跟你配合',
    placeholder: '例如：先给结论，代码要能直接运行',
    file: 'preferences.md',
  },
] as const

export type QuickFieldKey = (typeof QUICK_FIELDS)[number]['key']
export type QuickField = (typeof QUICK_FIELDS)[number]

export type ProfileListKind = 'device' | 'server'
export type ProfileDeviceType = 'computer' | 'phone' | 'watch' | 'tablet' | 'other'
export interface ProfileListItem { id: string; name: string; type?: ProfileDeviceType }

const LIST_START = '<!-- profer:visible-list:start -->'
const LIST_END = '<!-- profer:visible-list:end -->'
const DEVICE_TYPES = new Set<ProfileDeviceType>(['computer', 'phone', 'watch', 'tablet', 'other'])

function listValue(item: ProfileListItem, kind: ProfileListKind): string {
  const name = item.name.replace(/[\[\]]/g, '').trim()
  const id = item.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)
  if (!name || !id) return ''
  const type = kind === 'device' && item.type && DEVICE_TYPES.has(item.type) ? `|${item.type}` : ''
  return `- [${id}]${type} ${name}`
}

/** 读取可供用户展示的目录；兼容旧式列表行，仅取首个短名称而不暴露其余说明。 */
export function readProfileList(doc: string, kind: ProfileListKind): ProfileListItem[] {
  const lines = doc.replace(/\r\n/g, '\n').split('\n')
  const start = lines.indexOf(LIST_START)
  const end = start >= 0 ? lines.indexOf(LIST_END, start + 1) : -1
  if (start >= 0 && end > start) {
    return lines.slice(start + 1, end).flatMap((line) => {
      const match = /^\s*-\s+\[([\w-]+)\](?:\|(computer|phone|watch|tablet|other))?\s+(.+?)\s*$/.exec(line)
      if (!match) return []
      return [{ id: match[1]!, ...(kind === 'device' && match[2] ? { type: match[2] as ProfileDeviceType } : {}), name: match[3]! }]
    })
  }

  return lines.flatMap((line, index) => {
    const match = /^\s*[-*+]\s+(.+?)\s*$/.exec(line)
    if (!match || /^<!--/.test(line)) return []
    const value = match[1]!.trim()
    const name = kind === 'device'
      ? value.split(/[·|,，;；]/, 1)[0]!.trim()
      : /^(?:Team Server|NAS|VPS|云服务器|本地服务器|.*(?:server|服务器|主机|NAS))\b/i.test(value) ? value.split(/[·|,，;；]/, 1)[0]!.trim() : ''
    if (!name || name.length > 48 || /(?:password|token|私钥|密码|工具链|系统版本|访问方式|最近核对|用途|用于|192\.168\.|https?:\/\/)/i.test(name)) return []
    if (kind === 'device' && !/(?:macbook|mac mini|imac|iphone|ipad|apple watch|pixel|surface|thinkpad|电脑|手机|手表|平板)/i.test(name)) return []
    return [{ id: `legacy-${kind}-${index}`, name, ...(kind === 'device' ? { type: 'other' as const } : {}) }]
  })
}

/** 更新 Markdown 中 Agent 可读的显式目录，不改动标记区外正文。 */
export function writeProfileList(doc: string, kind: ProfileListKind, items: ProfileListItem[]): string {
  const lines = doc.replace(/\r\n/g, '\n').split('\n')
  const start = lines.indexOf(LIST_START)
  const end = start >= 0 ? lines.indexOf(LIST_END, start + 1) : -1
  const block = [LIST_START, ...items.map((item) => listValue(item, kind)).filter(Boolean), LIST_END]
  if (start >= 0 && end > start) lines.splice(start, end - start + 1, ...block)
  else lines.push('', ...block, '')
  return lines.join('\n').replace(/\n*$/, '\n')
}

const FIELD_TITLES = new Set<string>(QUICK_FIELDS.map((field) => field.title))

/** 字段所在的文件集合（去重）。 */
export const QUICK_FIELD_FILES = Array.from(new Set(QUICK_FIELDS.map((field) => field.file)))

/** 只匹配二级标题，三级及以下不参与分节。 */
const H2 = /^##(?!#)\s+(.+?)\s*$/
/** 任意层级标题行。 */
const ANY_HEADING = /^#{1,6}\s+/
/** 值行可能带的项目符号 / 有序列表前缀，替换时原样保留。 */
const LIST_PREFIX = /^(\s*(?:[-*+]\s+|\d+\.\s+)?)/

interface Section {
  title: string
  /** 标题行索引 */
  start: number
  /** 下一个二级标题行索引，或 lines.length（不含） */
  end: number
}

function splitLines(doc: string): string[] {
  return doc.replace(/\r\n/g, '\n').split('\n')
}

function findSections(lines: string[]): Section[] {
  const headings: Array<{ title: string; index: number }> = []
  lines.forEach((line, index) => {
    const match = H2.exec(line)
    if (match) headings.push({ title: match[1] ?? '', index })
  })
  return headings.map((heading, i) => ({
    title: heading.title,
    start: heading.index,
    end: i + 1 < headings.length ? (headings[i + 1]?.index ?? lines.length) : lines.length,
  }))
}

function isCommentLine(line: string): boolean {
  return /^\s*<!--/.test(line)
}

/** 把任意输入规整成单行字段值：折叠换行与连续空白，去掉前后空格。 */
export function normalizeFieldValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** 小节正文里第一个「值行」的相对索引；-1 表示没有。 */
function firstValueLineIndex(body: string[]): number {
  return body.findIndex((line) => line.trim().length > 0 && !isCommentLine(line) && !ANY_HEADING.test(line))
}

/**
 * 读取字段当前值：小节正文里第一个非注释、非空、非标题的行。
 * 去掉列表前缀；正文里其余行不参与读取（但写入时会被保留）。
 */
export function readField(doc: string, title: string): string {
  const lines = splitLines(doc)
  const section = findSections(lines).find((item) => item.title === title)
  if (!section) return ''
  const body = lines.slice(section.start + 1, section.end)
  const index = firstValueLineIndex(body)
  if (index < 0) return ''
  const valueLine = body[index] ?? ''
  return normalizeFieldValue(valueLine.replace(LIST_PREFIX, ''))
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const next = lines.slice()
  while (next.length > 0 && (next[next.length - 1] ?? '').trim() === '') next.pop()
  return next
}

/**
 * 写入字段值，返回新的文档全文。
 *
 * - 小节不存在且 value 非空：在文末按规范追加 `## 标题` + 值行。
 * - 小节不存在且 value 为空：原文返回（字节级不变）。
 * - 小节存在：只替换 / 插入 / 删除「值行」，注释、空行、补充行、其它小节逐行保留。
 * - value 为空且小节删掉值行后已无实质内容：整节删除。
 */
export function writeField(doc: string, title: string, rawValue: string): string {
  const value = normalizeFieldValue(rawValue)
  const lines = splitLines(doc)
  const section = findSections(lines).find((item) => item.title === title)

  if (!section) {
    if (!value) return doc
    const base = trimTrailingBlankLines(lines)
    return [...base, '', `## ${title}`, '', value, ''].join('\n')
  }

  const body = lines.slice(section.start + 1, section.end)
  const valueIndex = firstValueLineIndex(body)
  const nextBody = body.slice()

  if (valueIndex >= 0) {
    const originalLine = body[valueIndex] ?? ''
    const prefix = LIST_PREFIX.exec(originalLine)?.[1] ?? ''
    if (value) nextBody[valueIndex] = `${prefix}${value}`
    else nextBody.splice(valueIndex, 1)
  } else if (value) {
    // 没有值行：插到第一条非空行之前，保持注释在原位。
    const firstNonBlank = body.findIndex((line) => line.trim().length > 0)
    nextBody.splice(firstNonBlank < 0 ? 0 : firstNonBlank, 0, value)
  }

  const hasSubstantiveContent = nextBody.some(
    (line) => line.trim().length > 0 && !isCommentLine(line),
  )
  if (!value && !hasSubstantiveContent) {
    const next = [...lines.slice(0, section.start), ...lines.slice(section.end)]
    return trimTrailingBlankLines(next).join('\n') + '\n'
  }

  const next = [
    ...lines.slice(0, section.start + 1),
    ...nextBody,
    ...lines.slice(section.end),
  ]
  return trimTrailingBlankLines(next).join('\n') + '\n'
}

/**
 * 「自由补充」预览：文档里除首屏结构化字段小节之外的正文纯文本，
 * 去掉各层级标题与注释。用于在概览里展示用户已手写的画像内容。
 */
export function freeTextPreview(doc: string): string {
  const lines = splitLines(doc)
  const sections = findSections(lines)
  const clean = (chunk: string[]) => chunk.filter((line) => !ANY_HEADING.test(line) && !isCommentLine(line))
  const chunks: string[] = []

  chunks.push(...clean(lines.slice(0, sections[0]?.start ?? lines.length)))
  for (const section of sections) {
    if (isFieldTitle(section.title)) continue
    chunks.push(...clean(lines.slice(section.start + 1, section.end)))
  }
  return normalizeFieldValue(plainText(chunks.join('\n')))
}

/** 去掉常见 Markdown 标记，得到可展示的纯文本（供概览摘要使用）。 */
export function plainText(content: string): string {
  return content
    .replace(/^---[\s\S]*?---\s*/m, '')
    .replace(/<!--([\s\S]*?)-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+.*$/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 判断某标题是否为首屏结构化字段（概览里跳过，避免重复展示）。 */
export function isFieldTitle(title: string): boolean {
  return FIELD_TITLES.has(title)
}

/** 列出文档里除结构化字段外的自定义二级标题。 */
export function customSectionTitles(doc: string): string[] {
  return findSections(splitLines(doc))
    .map((section) => section.title)
    .filter((title) => !isFieldTitle(title))
}
