/**
 * profer profile — 用户画像读写（无需 UI / Electron）。
 *
 * 画像的存储与投影都在 `@profer/user-memory`，这里只负责命令行形态：
 *   show     用户名、头像、字段、文件树一览
 *   get      读单个字段
 *   set      写单个字段（行级替换，保留用户手写内容）
 *   context  输出可直接拼进 system prompt 的画像块
 *   search   在全局记忆里搜关键词
 *
 * 输出约定沿用 CLI 全局规则：数据走 stdout，提示走 stderr。
 * 因此 `profer profile get address` 可以直接被 `$(...)` 消费。
 */
import { register } from '../registry'
import { emitJson, emitText, info, EXIT_OK, UsageError } from '../output'
import { numFlag } from '../args'
import { resolveConfigDir } from '../paths'
import {
  GLOBAL_MEMORY_INDEX_FILE,
  QUICK_FIELDS,
  buildUserContext,
  getGlobalMemoryDir,
  getGlobalMemorySummary,
  listGlobalMemoryFiles,
  readGlobalMemoryFile,
  readProfileField,
  readProfileFields,
  readUserProfile,
  searchGlobalMemory,
  writeProfileField,
} from '@profer/user-memory'
import type { SkillFileNode } from '@profer/shared'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatTime(ms?: number): string {
  if (!ms) return '—'
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

function flattenFiles(nodes: SkillFileNode[]): Array<{ relativePath: string; size: number }> {
  const out: Array<{ relativePath: string; size: number }> = []
  const walk = (list: SkillFileNode[]) => {
    for (const node of list) {
      if (node.type === 'directory') walk(node.children ?? [])
      else out.push({ relativePath: node.relativePath, size: node.size ?? 0 })
    }
  }
  walk(nodes)
  return out
}

function readMemoryIndex(configDir: string): string {
  try {
    return readGlobalMemoryFile(configDir, GLOBAL_MEMORY_INDEX_FILE).content ?? ''
  } catch {
    return ''
  }
}

register({
  namespace: 'profile',
  name: 'show',
  summary: '画像总览：用户名 / 头像 / 字段 / 记忆文件',
  usage: 'profile show [--json]',
  run: (ctx) => {
    const configDir = resolveConfigDir(ctx.pathOpts)
    const profile = readUserProfile(configDir)
    const summary = getGlobalMemorySummary(configDir)
    const fields = readProfileFields(configDir)
    const files = flattenFiles(listGlobalMemoryFiles(configDir))
    const memoryDir = getGlobalMemoryDir(configDir)

    if (ctx.json) {
      emitJson({
        userName: profile.userName,
        avatar: profile.avatar,
        configDir,
        memoryDir,
        summary,
        fields: fields.map((field) => ({ key: field.key, title: field.title, file: field.file, value: field.value })),
        files,
      })
      return EXIT_OK
    }

    const lines: string[] = []
    lines.push(`用户名: ${profile.userName}`)
    lines.push(`头像: ${profile.avatar}`)
    lines.push(`配置目录: ${configDir}`)
    lines.push(`记忆目录: ${memoryDir}`)
    lines.push(`记忆: ${summary.fileCount} 个文件 · ${formatBytes(summary.totalSize)} · 更新 ${formatTime(summary.updatedAt)}`)
    lines.push('')
    lines.push('字段:')
    for (const field of fields) {
      const value = field.value || '—'
      lines.push(`  ${field.title.padEnd(6, '　')} ${value}`)
    }
    lines.push('')
    lines.push('文件:')
    for (const file of files) {
      lines.push(`  ${file.relativePath.padEnd(28)} ${formatBytes(file.size)}`)
    }
    emitText(lines.join('\n'))
    return EXIT_OK
  },
})

register({
  namespace: 'profile',
  name: 'get',
  summary: '读取单个画像字段（stdout 只输出值，便于脚本消费）',
  usage: `profile get <${QUICK_FIELDS.map((f) => f.key).join('|')}> [--json]`,
  run: (ctx) => {
    const key = ctx.args.positionals[0]
    if (!key) throw new UsageError('缺少字段名')

    const configDir = resolveConfigDir(ctx.pathOpts)
    const field = readProfileField(configDir, key)

    if (ctx.json) {
      emitJson(field)
      return EXIT_OK
    }
    if (!field.value) {
      info(`（${field.title} 未填写）`)
      return EXIT_OK
    }
    emitText(field.value)
    return EXIT_OK
  },
})

register({
  namespace: 'profile',
  name: 'set',
  summary: '写入单个画像字段（行级替换，保留手写内容）',
  usage: `profile set <${QUICK_FIELDS.map((f) => f.key).join('|')}> <value> [--json]`,
  run: (ctx) => {
    const key = ctx.args.positionals[0]
    // 显式传空串（`profile set address ""`）是合法的「清空字段」，
    // 因此用 positionals 个数判断，而不是用值是否为空。
    if (!key) throw new UsageError('缺少字段名')
    if (ctx.args.positionals.length < 2) throw new UsageError('缺少字段值（清空请显式传空串）')
    const value = ctx.args.positionals.slice(1).join(' ')

    const configDir = resolveConfigDir(ctx.pathOpts)
    const field = writeProfileField(configDir, key, value)

    if (ctx.json) {
      emitJson(field)
      return EXIT_OK
    }
    info(`已写入 ${field.file} → ${field.title}`)
    emitText(field.value)
    return EXIT_OK
  },
})

register({
  namespace: 'profile',
  name: 'context',
  summary: '输出可直接拼进 system prompt 的画像块',
  usage: 'profile context [--json]',
  run: (ctx) => {
    const configDir = resolveConfigDir(ctx.pathOpts)
    const profile = readUserProfile(configDir)
    const memoryIndex = readMemoryIndex(configDir)
    const text = buildUserContext({ userName: profile.userName, memoryIndex })

    if (ctx.json) {
      emitJson({ userName: profile.userName, memoryIndex, text })
      return EXIT_OK
    }
    emitText(text)
    return EXIT_OK
  },
})

register({
  namespace: 'profile',
  name: 'search',
  summary: '在全局记忆里搜索关键词，返回文件与片段',
  usage: 'profile search <query> [--limit N] [--json]',
  run: (ctx) => {
    const query = ctx.args.positionals.join(' ').trim()
    if (!query) throw new UsageError('缺少搜索关键词')

    const configDir = resolveConfigDir(ctx.pathOpts)
    const limit = numFlag(ctx.args.flags, 'limit')
    const hits = searchGlobalMemory(configDir, query, limit)

    if (ctx.json) {
      emitJson(hits)
      return EXIT_OK
    }
    if (hits.length === 0) {
      info(`（没有命中: ${query}）`)
      return EXIT_OK
    }
    emitText(hits.map((hit) => `${hit.relativePath}\n${hit.content.trim()}`).join('\n\n---\n\n'))
    return EXIT_OK
  },
})
