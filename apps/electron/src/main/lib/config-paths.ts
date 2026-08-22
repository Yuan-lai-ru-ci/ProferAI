/**
 * 配置路径工具
 *
 * 管理 Profer 应用的本地配置文件路径。
 * 所有用户配置存储在 ~/.profer/ 目录下。
 */

import { join, basename, resolve, sep, relative } from 'node:path'
import { mkdirSync, existsSync, cpSync, rmSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { RENAMED_DEFAULT_SKILLS } from './default-skill-slugs'

/** Vite 开发服务器端口（避开旧 Proma 的 5173） */
export const VITE_DEV_SERVER_PORT = 5174
/** Vite 开发服务器 URL */
export const VITE_DEV_SERVER_URL = `http://localhost:${VITE_DEV_SERVER_PORT}`

/**
 * 获取默认配置目录名称
 *
 * 开发模式下返回 '.profer-dev'，正式版本返回 '.profer'。
 * 受控运行可通过 PROFER_CONFIG_DIR 覆盖实际配置根；该覆盖不改变默认名称。
 *
 * 检测优先级：
 * 1. PROFER_DEV=1 环境变量（显式覆盖）
 * 2. Electron app.isPackaged（未打包 = 开发模式）
 * 3. 兜底 '.profer'
 */
let _configDirName: string | undefined

export function getConfigDirName(): string {
  if (_configDirName === undefined) {
    if (process.env.PROFER_DEV === '1') {
      _configDirName = '.profer-dev'
    } else {
      try {
        const { app } = require('electron')
        _configDirName = app.isPackaged ? '.profer' : '.profer-dev'
      } catch {
        _configDirName = '.profer'
      }
    }
    const mode = _configDirName === '.profer-dev' ? '开发模式' : '正式版本'
    console.log(`[配置] 默认配置目录名: ~/${_configDirName}/（${mode}）；实际路径可由 PROFER_CONFIG_DIR 覆盖`)
  }
  return _configDirName
}

/**
 * 从旧 Proma 目录迁移到新 Profer 目录（一次性）
 * 如果 ~/.profer/ 或 ~/.profer-dev/ 不存在但对应的旧目录存在，则重命名迁移
 */
export function migrateFromProferIfNeeded(): void {
  try {
    const name = getConfigDirName()
    const newDir = join(homedir(), name)
    const oldName = name.replace('profer', 'proma')
    const oldDir = join(homedir(), oldName)

    if (!existsSync(newDir) && existsSync(oldDir)) {
      console.log(`[迁移] 从 ~/${oldName}/ 迁移到 ~/${name}/`)
      renameSync(oldDir, newDir)
      console.log('[迁移] 数据迁移完成')
    }
  } catch (err) {
    console.error('[迁移] 数据迁移失败（不影响使用）:', err)
  }
}

/**
 * 获取配置目录路径
 *
 * 开发模式返回 ~/.profer-dev/，正式版本返回 ~/.profer/。
 * 如果目录不存在则自动创建。
 */
export function getConfigDir(): string {
  // 自动化测试和受控诊断可显式隔离配置根目录；常规运行仍使用用户目录。
  const override = process.env.PROFER_CONFIG_DIR?.trim()
  const configDir = override ? resolve(override) : join(homedir(), getConfigDirName())

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
    console.log(`[配置] 已创建配置目录: ${configDir}`)
  }

  return configDir
}

/**
 * 获取渠道配置文件路径
 *
 * @returns ~/.profer/channels.json
 */
export function getChannelsPath(): string {
  return join(getConfigDir(), 'channels.json')
}

/**
 * 获取对话索引文件路径
 *
 * @returns ~/.profer/conversations.json
 */
export function getConversationsIndexPath(): string {
  return join(getConfigDir(), 'conversations.json')
}

/**
 * 获取对话消息目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/.profer/conversations/
 */
export function getConversationsDir(): string {
  const dir = join(getConfigDir(), 'conversations')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建对话目录: ${dir}`)
  }

  return dir
}

/**
 * 获取指定对话的消息文件路径
 *
 * @param id 对话 ID
 * @returns ~/.profer/conversations/{id}.jsonl
 */
export function getConversationMessagesPath(id: string): string {
  return join(getConversationsDir(), `${id}.jsonl`)
}

/**
 * 获取附件存储根目录
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/.profer/attachments/
 */
export function getAttachmentsDir(): string {
  const dir = join(getConfigDir(), 'attachments')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建附件目录: ${dir}`)
  }

  return dir
}

/**
 * 获取自定义通知音效存储目录
 *
 * 用户通过设置界面添加的音频文件会复制到此目录。
 * 如果目录不存在则自动创建。
 *
 * @returns ~/.profer/custom-sounds/
 */
export function getCustomSoundsDir(): string {
  const dir = join(getConfigDir(), 'custom-sounds')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建自定义音效目录: ${dir}`)
  }

  return dir
}

/**
 * 获取指定对话的附件目录
 *
 * 如果目录不存在则自动创建。
 *
 * @param conversationId 对话 ID
 * @returns ~/.profer/attachments/{conversationId}/
 */
export function getConversationAttachmentsDir(conversationId: string): string {
  const dir = join(getAttachmentsDir(), conversationId)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 解析附件相对路径为完整路径
 *
 * @param localPath 相对路径 {conversationId}/{uuid}.ext
 * @returns 完整路径 ~/.profer/attachments/{conversationId}/{uuid}.ext
 */
export function resolveAttachmentPath(localPath: string): string {
  return join(getAttachmentsDir(), localPath)
}

/**
 * 获取应用设置文件路径
 *
 * @returns ~/.profer/settings.json
 */
export function getSettingsPath(): string {
  return join(getConfigDir(), 'settings.json')
}

/**
 * 获取用户档案文件路径
 *
 * @returns ~/.profer/user-profile.json
 */
export function getUserProfilePath(): string {
  return join(getConfigDir(), 'user-profile.json')
}

/**
 * 获取代理配置文件路径
 *
 * @returns ~/.profer/proxy-settings.json
 */
export function getProxySettingsPath(): string {
  return join(getConfigDir(), 'proxy-settings.json')
}

/**
 * 获取系统提示词配置文件路径
 *
 * @returns ~/.profer/system-prompts.json
 */
export function getSystemPromptsPath(): string {
  return join(getConfigDir(), 'system-prompts.json')
}

/**
 * 获取记忆配置文件路径
 *
 * @returns ~/.profer/memory.json
 */
export function getMemoryConfigPath(): string {
  return join(getConfigDir(), 'memory.json')
}

/**
 * 获取 Agent 预设配置文件路径
 *
 * @returns ~/.profer/agent-presets.json
 */
export function getAgentPresetsPath(): string {
  return join(getConfigDir(), 'agent-presets.json')
}

/**
 * 获取 Chat 工具配置文件路径
 *
 * @returns ~/.profer/chat-tools.json
 */
export function getChatToolsConfigPath(): string {
  return join(getConfigDir(), 'chat-tools.json')
}

/**
 * 获取 Agent 会话索引文件路径
 *
 * @returns ~/.profer/agent-sessions.json
 */
export function getAgentSessionsIndexPath(): string {
  return join(getConfigDir(), 'agent-sessions.json')
}

/** 由 Agent 启动且需跨聊天管理的运行进程登记表。 */
export function getRuntimeProcessesPath(): string {
  return join(getConfigDir(), 'runtime-processes.json')
}

/**
 * 获取 Agent 会话消息目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/.profer/agent-sessions/
 */
export function getAgentSessionsDir(): string {
  const dir = join(getConfigDir(), 'agent-sessions')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 会话目录: ${dir}`)
  }

  return dir
}

/**
 * 获取指定 Agent 会话的消息文件路径
 *
 * @param id 会话 ID
 * @returns ~/.profer/agent-sessions/{id}.jsonl
 */
export function getAgentSessionMessagesPath(id: string): string {
  return join(getAgentSessionsDir(), `${id}.jsonl`)
}

/**
 * 获取指定 Pi Host Harness 会话级事件账本路径。
 *
 * 与 Profer 展示消息、Project Graph JSONL 并列，但仅保存内部执行控制事实；
 * 缺失文件代表该历史会话尚未启用 Harness，读取方必须安全降级为空 snapshot。
 */
export function getPiHarnessEventsPath(id: string): string {
  return join(getAgentSessionsDir(), `${id}-pi-harness.jsonl`)
}

/**
 * 获取 Agent 工作区索引文件路径
 *
 * @returns ~/.profer/agent-workspaces.json
 */
export function getAgentWorkspacesIndexPath(): string {
  return join(getConfigDir(), 'agent-workspaces.json')
}

/**
 * 获取 Agent 工作区根目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/.profer/agent-workspaces/
 */
export function getAgentWorkspacesDir(): string {
  const dir = join(getConfigDir(), 'agent-workspaces')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 工作区目录: ${dir}`)
  }

  return dir
}

/**
 * 获取指定 Agent 工作区的目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns ~/.profer/agent-workspaces/{slug}/
 */
export function getAgentWorkspacePath(slug: string): string {
  const dir = join(getAgentWorkspacesDir(), slug)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 工作区: ${dir}`)
  }

  return dir
}

/**
 * 获取指定工作区的 MCP 配置文件路径
 *
 * @param slug 工作区 slug
 * @returns ~/.profer/agent-workspaces/{slug}/mcp.json
 */
export function getWorkspaceMcpPath(slug: string): string {
  return join(getAgentWorkspacePath(slug), 'mcp.json')
}

/**
 * 获取指定工作区的 Agent 预设配置文件路径
 *
 * 预设为工作区级配置（与 mcp.json 同构）：内置三预设恒定可见，
 * 自定义预设与默认预设按工作区存储。
 *
 * @param slug 工作区 slug
 * @returns ~/.profer/agent-workspaces/{slug}/agent-presets.json
 */
export function getWorkspaceAgentPresetsPath(slug: string): string {
  return join(getAgentWorkspacePath(slug), 'agent-presets.json')
}

/**
 * 获取指定工作区的 Skills 目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns ~/.profer/agent-workspaces/{slug}/skills/
 */
export function getWorkspaceSkillsDir(slug: string): string {
  const dir = join(getAgentWorkspacePath(slug), 'skills')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 获取工作区文件目录路径
 *
 * 工作区内所有会话可访问的文件存放于此。
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns ~/.profer/agent-workspaces/{slug}/workspace-files/
 */
export function getWorkspaceFilesDir(slug: string): string {
  const dir = join(getAgentWorkspacePath(slug), 'workspace-files')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 解析工作区文件目录路径（只读，不创建目录）
 *
 * 与 getWorkspaceFilesDir 的区别：不会触发 mkdir 副作用，
 * 适用于 /now 等只读查询场景。
 *
 * @param slug 工作区 slug
 * @returns ~/.profer/agent-workspaces/{slug}/workspace-files/
 */
export function resolveWorkspaceFilesDir(slug: string): string {
  return join(getConfigDir(), 'agent-workspaces', slug, 'workspace-files')
}

/**
 * 解析 Agent 会话工作目录路径（只读，不创建目录）
 *
 * 与 getAgentSessionWorkspacePath 的区别：不会触发 mkdir 副作用，
 * 适用于 /now 等只读查询场景。
 *
 * @param slug 工作区 slug
 * @param sessionId 会话 ID
 * @returns ~/.profer/agent-workspaces/{slug}/{sessionId}/
 */
export function resolveAgentSessionWorkspacePath(slug: string, sessionId: string): string {
  return join(getConfigDir(), 'agent-workspaces', slug, sessionId)
}

/**
 * 获取工作区不活跃 Skills 目录路径
 *
 * 禁用的 Skill 会被移动到此目录，Agent SDK 不会扫描该目录。
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns ~/.profer/agent-workspaces/{slug}/skills-inactive/
 */
export function getInactiveSkillsDir(slug: string): string {
  const dir = join(getAgentWorkspacePath(slug), 'skills-inactive')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 获取默认 Skills 模板目录路径
 *
 * 新建工作区时自动复制此目录的内容到工作区 skills/ 下。
 *
 * @returns ~/.profer/default-skills/
 */
export function getDefaultSkillsDir(): string {
  const dir = join(getConfigDir(), 'default-skills')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 获取打包进 App 的 profer CLI 二进制路径。
 *
 * 打包模式下从 process.resourcesPath/bin 取（electron-builder extraResources 注入）。
 * 开发模式下没有编译二进制——返回 undefined，由调用方回退到源码运行
 * （bun apps/cli/src/index.ts）。
 *
 * @returns 二进制绝对路径；不存在时返回 undefined
 */
export function getBundledCliPath(): string | undefined {
  const { app } = require('electron')
  if (!app.isPackaged) return undefined
  const binName = process.platform === 'win32' ? 'profer.exe' : 'profer'
  const cliPath = join(process.resourcesPath, 'bin', binName)
  return existsSync(cliPath) ? cliPath : undefined
}

/**
 * 从 SKILL.md 的 YAML frontmatter 中解析 version 字段
 *
 * 无 version 字段时返回 '0.0.0'（确保旧 Skill 会被更新）。
 */
export function parseSkillVersion(skillDir: string): string {
  const skillMdPath = join(skillDir, 'SKILL.md')
  if (!existsSync(skillMdPath)) return '0.0.0'

  try {
    let content = readFileSync(skillMdPath, 'utf-8')
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1)
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
    if (!fmMatch?.[1]) return '0.0.0'

    for (const line of fmMatch[1].split('\n')) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '')
      if (key === 'version' && value) return value
    }
  } catch {
    // 解析失败视为最低版本
  }

  return '0.0.0'
}

/** 比较两个 semver 版本字符串
 *
 * @returns 正数表示 a > b，0 表示相等，负数表示 a < b
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 防御性目录基名集合：复制 default skills 时永远跳过这些目录，避免
 *  .git 0444 文件、node_modules 文件爆炸等场景把启动期同步链路炸掉。 */
const DEFAULT_SKILL_COPY_BLOCKLIST = new Set([
  '.git',
  '.DS_Store',
  'node_modules',
  'dist',
  '.next',
  '.cache',
  '.turbo',
  '__pycache__',
])

const DEFAULT_SKILL_SEED_STATE_FILE = '.seed-state.json'

type DefaultSkillSeedOwner = 'managed' | 'user-owned'

interface DefaultSkillSeedRecord {
  /** 最近一次由应用写入的内置内容哈希；只有未变更时才可自动升级。 */
  bundledHash?: string
  bundledVersion?: string
  owner: DefaultSkillSeedOwner
}

interface DefaultSkillSeedState {
  version: 1
  skills: Record<string, DefaultSkillSeedRecord>
}

/**
 * 将旧默认 Skill slug 迁移到新 slug。
 *
 * 只在目标目录不存在时移动，避免覆盖用户已经创建或同步的新 Skill；版本历史和
 * 受管种子记录同时迁移，让后续默认内容升级仍能正确识别用户改动。
 */
function migrateRenamedDefaultSkills(userDir: string, state: DefaultSkillSeedState): boolean {
  let stateChanged = false
  const historyDir = join(userDir, '..', 'default-skills-history')

  for (const [oldSlug, newSlug] of RENAMED_DEFAULT_SKILLS) {
    const oldPath = join(userDir, oldSlug)
    const newPath = join(userDir, newSlug)
    if (existsSync(newPath)) {
      if (existsSync(oldPath)) {
        console.warn(`[配置] 默认 Skill slug 迁移冲突，保留新旧目录: ${oldSlug} / ${newSlug}`)
      }
      continue
    }

    if (existsSync(oldPath)) {
      try {
        renameSync(oldPath, newPath)
        console.log(`[配置] 已迁移默认 Skill: ${oldSlug} → ${newSlug}`)
      } catch (err) {
        console.warn(`[配置] 迁移默认 Skill 失败 (${oldSlug} → ${newSlug}):`, err)
        continue
      }
    }

    const oldHistoryPath = join(historyDir, oldSlug)
    const newHistoryPath = join(historyDir, newSlug)
    if (existsSync(oldHistoryPath) && !existsSync(newHistoryPath)) {
      try {
        renameSync(oldHistoryPath, newHistoryPath)
      } catch (err) {
        console.warn(`[配置] 迁移默认 Skill 历史失败 (${oldSlug} → ${newSlug}):`, err)
      }
    }

    const oldRecord = state.skills[oldSlug]
    if (oldRecord && !state.skills[newSlug]) {
      state.skills[newSlug] = oldRecord
      delete state.skills[oldSlug]
      stateChanged = true
    }
  }

  return stateChanged
}

/** 测试用：覆盖内置 default-skills 来源，不触发 Electron 路径解析。 */
let testBundledSkillsDirOverride: string | undefined

export function __setBundledSkillsDirForTest(dir: string | undefined): void {
  testBundledSkillsDirOverride = dir
}

function defaultSkillCopyFilter(src: string): boolean {
  return !DEFAULT_SKILL_COPY_BLOCKLIST.has(basename(src))
}

function getBundledSkillsDir(): string {
  if (testBundledSkillsDirOverride) return testBundledSkillsDirOverride
  const { app } = require('electron')
  return app.isPackaged
    ? join(process.resourcesPath, 'default-skills')
    : join(__dirname, '../default-skills')
}

function getDefaultSkillSeedStatePath(userDir: string): string {
  return join(userDir, DEFAULT_SKILL_SEED_STATE_FILE)
}

function isDefaultSkillSeedRecord(value: unknown): value is DefaultSkillSeedRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<DefaultSkillSeedRecord>
  return record.owner === 'managed' || record.owner === 'user-owned'
}

function readDefaultSkillSeedState(userDir: string): DefaultSkillSeedState {
  const path = getDefaultSkillSeedStatePath(userDir)
  if (!existsSync(path)) return { version: 1, skills: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<DefaultSkillSeedState>
    if (parsed.version !== 1 || !parsed.skills || typeof parsed.skills !== 'object') {
      throw new Error('格式无效')
    }
    const skills = Object.fromEntries(
      Object.entries(parsed.skills).filter(([, record]) => isDefaultSkillSeedRecord(record)),
    )
    return { version: 1, skills }
  } catch {
    // 无法验证旧状态时宁可将所有已有 Skill 视为用户拥有，绝不冒险覆盖。
    console.warn('[配置] 默认 Skill 同步状态不可读，将保护已有元 Skill')
    return { version: 1, skills: {} }
  }
}

function writeDefaultSkillSeedState(userDir: string, state: DefaultSkillSeedState): void {
  writeFileSync(getDefaultSkillSeedStatePath(userDir), `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
}

/**
 * 计算 Skill 目录的确定性 SHA-256：覆盖全部非屏蔽文件及其相对路径。
 * 任意正文、frontmatter 或附属文件变化都会令哈希不同。
 */
function normalizeSkillFileForHash(content: Buffer): Buffer {
  // Git 的 autocrlf、历史压缩包与 cpSync 可能只造成 LF/CRLF 差异；这不应被
  // 误判为用户编辑，否则内置 Skill 永远无法平滑升级。
  return Buffer.from(content.toString('utf-8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'), 'utf-8')
}

function hashDefaultSkillDir(dir: string): string {
  const files: string[] = []
  const collect = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (DEFAULT_SKILL_COPY_BLOCKLIST.has(entry.name)) continue
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) collect(absolute)
      else if (entry.isFile()) files.push(absolute)
    }
  }
  collect(dir)

  const hash = createHash('sha256')
  for (const file of files.sort((a, b) => a.localeCompare(b))) {
    const path = relative(dir, file).split(sep).join('/')
    hash.update(path).update('\0').update(normalizeSkillFileForHash(readFileSync(file))).update('\0')
  }
  return hash.digest('hex')
}

/**
 * 引入 .seed-state.json 之前随 Proma/早期 Profer 发出的整个 Skill 目录指纹。
 *
 * 只有目录内容完整命中某个历史出厂版本（忽略 BOM/换行）才会被接管为受管种子；
 * 用户修改正文、增删脚本或参考资料都会改变指纹，继续遵循“绝不覆盖”的保守策略。
 * key 必须与当前目录 slug 一致，防止同内容被错误迁移到其他 Skill。
 */
const LEGACY_BUNDLED_SKILL_DIRECTORY_HASHES: Readonly<Record<string, readonly string[]>> = {
  automation: [
    '385cfbfd1cfe1c433aafef7f54444968505f1deb6342473f974e3cd82fbbe332',
    'b278054bad5a908d28a2954d3028dbdcd35b1696e7928ef4522243392e57774a',
    '8483c3b1c94d55c10dbdb7311f8b2ac546db30c8b9dbea372f1cc2e7b2cd74d5',
    '759c7211b177ab5b553565e6db0cc2d5f23f45d53f698c22665c84a2bf82d186',
    'd17e17b31aa179d211d8037acd8bcbe0194a2fcb3b5e8aa4c28f436fe91f4f6f',
    'e8a1e60bf4782061dfb7d0d4aab8057d22a7b91042673a26d80e03d9e5f51b03',
  ],
  brainstorming: [
    '05565edbd09ec12cb3aa3bd0a9af83dbc86524101278428579a3462d59c4ded3',
    '3682bde98145886e0425db07c410d6c168bbb3e7766bf6f857312755ed702a4f',
  ],
  docx: [
    '56c6f07ce8d9adf996702606c4058888530aa05aa720759bcca16cb47f21f74e',
    'd3d5d97b9c08063fbf6098478b46dedda368dcc6d21ce54596890e2e024da2a5',
    'cc143d3b68617792889733f6d14998a88c9c2f97f7f91dad898589c8879f50c5',
  ],
  'executing-plans': [
    '3a5e7552484de0cb4a2bdb46df32fc418b053fe8ba582d7a7ad92d5cecbcd8ab',
    '62d15c1379c29635aa2bb28519c6c22aa4e84256cc4245dc271e1defc7c6532a',
  ],
  'find-skills': [
    '1af4daf8ce4f3df37d3cf1166bee91e7408fe69d171789b1b5a4e71c6b033676',
    'c1720ff6ac18832a05d91cd913eee8781310e9f376ce77b8d5fc25a32e530a89',
  ],
  'guizang-ppt-skill': [
    '44172ecea6f975a958a0e919529f09398929075a0734fa659e5f38534bb0f724',
  ],
  'in-app-browser': [
    'd4a70341754d71806a296510aa423450e50c94d71b12c88406ebf9777b9dfea5',
    'c3960d6d53c3c4d8cea937c9cf5c8c7a0b6779770b557912f8fe34c67806d2d0',
  ],
  pdf: [
    '11a233660874233aed3d395e3aac238eaacb27759efdf3aef33ad792691b545c',
    'd6c369b43ae13ebb7fb3919ec77d15c8e17bf3de9afcb6bfe78c9a779dde927c',
    '6bdc1954a0db9694efb62c6a7b29767acfb8177442a5a6112d5134dacd70bde0',
    '3fbb1ba6a5281ed04cc1215ca7e3acc8a9da9c7be25fca3ff8eb27872b9fa0c9',
    '7c96a2fd5ed6490df5282564198dba6a93ca5f576457908214cb2599e47a3da5',
  ],
  pptx: [
    'cda0e526ddd0f5ce7bd179fd0ff1d9b65cf0d5e6b7689619dcc0a9158331f2a5',
    'd5db190ef90f1dec6a1ab53b30879176c3e72177bdca282b552e02af5b05ecef',
    'fee49051cf9e9bb43feee88742847dcd7552ed7a2ef233e553d3f501a6247e76',
    'd6f29ddbde486d3efce867ebe711045a74b0e9757e98461df3aaa4037c48b50b',
    'b903b70c73ef7182f00810ad498a97fac0411976673681c616e373ac390ec04d',
  ],
  'profer-coach': [
    '9a0c6775c83d753779d4293eb356c253ceab87b82e6ef91b529e359a922440ad',
    'f0383281768dbf0e909c4922c9ef33b86c14d96d5c1cc118a0f6806080ee1364',
  ],
  'session-cleaner': [
    'e32455faa14a300485b4a6abb88e6440e8f74f491647f0787e4d24b661302017',
    '34380c1f3428c38c4742449046295a3fe04305f97f43f75243bce0701fd2de00',
    '44f0d3a73e4dded8aef708b93208bc3470b7e636ac8a1d33d5f7c5ed73457ceb',
  ],
  'skill-creator': [
    'ef520dc392bfff0cba7d4485c78a6ac98e403ecd85b7110d7fd2364915108746',
    '6476bfd29f5af50a6a5d0b4d6b4d521830bd34b4e2b56f159e2c286d77917488',
    '17fb80a21629055c53eb6020dfd1aa2330197058fc5fb72462f378f405b309dc',
    'e141179cf76bbe3fdbd2616f1573b24b8abb3dca93676ca782d736c63a73c074',
  ],
  'tool-builder': [
    '1651dfd1a449335e0455976feae678ff09052855cf060d94c114435be8071b25',
    '17ea35385ea543fc668baad9f3cc2941e6c86cdb4e944df9e600f81d5d2d577e',
    '43ba5b045e5f7bd5d3c0f613b3008f3710f47b14bf01ccd5695f22bfc6f51cb6',
  ],
  'user-sense': [
    '3db6c922794255a83631237dcf10792ee58c392f42015972e7d067c019bc4fb8',
    'bb6b523acdbd108ac99a131e8d9b6f4ad51bd8c32b64abeb0461dd192a3ae2bc',
  ],
  'writing-plans': [
    'd5a0f5f9ab3dec492442757151c4299ac6f71f347665a498f6cd7d79be59ecd1',
    'b7c6507b412401048cfd24079fa1752c76c97684b538e7d843f2d8ff4446f166',
  ],
  xlsx: [
    'ba43824de5faed80868258dac55163e0753ed8d3c42d23bbfec91313426c3d64',
    '6c059ec7720b628bf8eea36005aa062f4bb785ee4977033ada6d9f2da6d50ec9',
    'ff4b2e66b89e1a248d4270de95373b673a986d2976fe26afd7e0c90cc24deb50',
  ],
}

/** 测试用：注入最小历史种子指纹集，避免测试依赖真实产品文案。 */
let testLegacyBundledSkillDirectoryHashes: Readonly<Record<string, readonly string[]>> | undefined

export function __setLegacyBundledSkillDirectoryHashesForTest(
  hashes: Readonly<Record<string, readonly string[]>> | undefined,
): void {
  testLegacyBundledSkillDirectoryHashes = hashes
}

function isKnownLegacyBundledSkill(slug: string, skillDir: string): boolean {
  const expectedHashes = (testLegacyBundledSkillDirectoryHashes ?? LEGACY_BUNDLED_SKILL_DIRECTORY_HASHES)[slug]
  return !!expectedHashes && expectedHashes.includes(hashDefaultSkillDir(skillDir))
}

/**
 * 从 app bundle 同步默认 Skills 到 ~/.profer/default-skills/
 *
 * 打包模式下从 process.resourcesPath/default-skills 复制。
 * 开发模式下从源码 default-skills/ 目录复制。
 *
 * - 缺失的 Skill：直接复制，并记录内置内容基线。
 * - 已存在的受管 Skill：仅在内容仍等于上次内置基线且 bundled 更新时才覆盖。
 * - 有任意用户改动，或历史上没有可信内置基线的 Skill：保护本地内容，不自动覆盖。
 */
export function seedDefaultSkills(): void {
  const bundledDir = getBundledSkillsDir()

  if (!existsSync(bundledDir)) {
    console.log('[配置] 未找到内置 default-skills 目录，跳过')
    return
  }

  const userDir = getDefaultSkillsDir()
  const state = readDefaultSkillSeedState(userDir)
  let stateChanged = migrateRenamedDefaultSkills(userDir, state)

  try {
    const entries = readdirSync(bundledDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const source = join(bundledDir, entry.name)
      const target = join(userDir, entry.name)

      try {
        const bundledHash = hashDefaultSkillDir(source)
        const bundledVer = parseSkillVersion(source)
        const record = state.skills[entry.name]

        if (!existsSync(target)) {
          cpSync(source, target, { recursive: true, filter: defaultSkillCopyFilter })
          state.skills[entry.name] = { owner: 'managed', bundledHash, bundledVersion: bundledVer }
          stateChanged = true
          console.log(`[配置] 已同步默认 Skill: ${entry.name}`)
          continue
        }

        // 引入基线追踪前已有的元 Skill：早期版本会把它们直接标成无基线的
        // user-owned。两种情况下都只有精确命中已知历史出厂目录时才接管；未命中
        // （包括任意用户编辑）一律保护，绝不覆盖。
        const hasNoTrustworthyBaseline = !record || (record.owner === 'user-owned' && !record.bundledHash)
        if (hasNoTrustworthyBaseline) {
          if (isKnownLegacyBundledSkill(entry.name, target)) {
            rmSync(target, { recursive: true, force: true })
            cpSync(source, target, { recursive: true, filter: defaultSkillCopyFilter })
            state.skills[entry.name] = { owner: 'managed', bundledHash, bundledVersion: bundledVer }
            stateChanged = true
            console.log(`[配置] 已接管并升级历史内置 Skill: ${entry.name} (${bundledVer})`)
          } else if (!record) {
            state.skills[entry.name] = { owner: 'user-owned' }
            stateChanged = true
            console.log(`[配置] 保留已有元 Skill（缺少可信内置基线）: ${entry.name}`)
          }
          continue
        }

        if (record.owner === 'user-owned') continue

        const existingVer = parseSkillVersion(target)
        const currentHash = hashDefaultSkillDir(target)
        if (record.bundledHash !== currentHash) {
          state.skills[entry.name] = { ...record, owner: 'user-owned' }
          stateChanged = true
          console.log(`[配置] 保留用户修改的元 Skill: ${entry.name}`)
          continue
        }

        if (compareSemver(bundledVer, existingVer) > 0) {
          // rm-then-cp：rmSync 不依赖目标文件写权限（只读 .git/objects/ 等
          // 0444 文件用 cpSync({ force: true }) 无法覆盖会 EACCES，但
          // rmSync({ force: true }) 只需父目录可写就能 unlink）。
          rmSync(target, { recursive: true, force: true })
          cpSync(source, target, { recursive: true, filter: defaultSkillCopyFilter })
          state.skills[entry.name] = { owner: 'managed', bundledHash, bundledVersion: bundledVer }
          stateChanged = true
          console.log(`[配置] 已升级默认 Skill: ${entry.name} (${existingVer} → ${bundledVer})`)
        }
      } catch (err) {
        // 单 skill 失败不影响其他 skill 同步。这里吞错是为了防止启动期 bootstrap
        // 链路被任意一个 skill 的同步异常掀翻——窗口和托盘必须先出来。
        console.warn(`[配置] 同步默认 Skill 失败 (${entry.name})，跳过:`, err)
      }
    }

    if (stateChanged) writeDefaultSkillSeedState(userDir, state)
  } catch (err) {
    console.warn('[配置] 同步默认 Skills 失败:', err)
  }
}

/**
 * 获取微信配置文件路径
 *
 * @returns ~/.profer/wechat.json
 */
export function getWeChatConfigPath(): string {
  return join(getConfigDir(), 'wechat.json')
}

/**
 * 获取微信长轮询同步游标路径
 *
 * @returns ~/.profer/wechat-sync.json
 */
export function getWeChatSyncPath(): string {
  return join(getConfigDir(), 'wechat-sync.json')
}

/**
 * 获取钉钉配置文件路径
 *
 * @returns ~/.profer/dingtalk.json
 */
export function getDingTalkConfigPath(): string {
  return join(getConfigDir(), 'dingtalk.json')
}

/**
 * 获取飞书配置文件路径
 *
 * @returns ~/.profer/feishu.json
 */
export function getFeishuConfigPath(): string {
  return join(getConfigDir(), 'feishu.json')
}

/**
 * 获取飞书聊天绑定持久化路径
 *
 * @returns ~/.profer/feishu-bindings.json
 */
export function getFeishuBindingsPath(): string {
  return join(getConfigDir(), 'feishu-bindings.json')
}

/**
 * 获取某个飞书 Bot 的聊天绑定持久化路径
 *
 * @returns ~/.profer/feishu-bindings-{botId}.json
 */
export function getFeishuBotBindingsPath(botId: string): string {
  return join(getConfigDir(), `feishu-bindings-${botId}.json`)
}

/**
 * 获取某个飞书 Bot 的运行时元数据持久化路径
 *
 * 用于保存最近交互用户 open_id 等需要跨进程重启恢复的状态。
 *
 * @returns ~/.profer/feishu-metadata-{botId}.json
 */
export function getFeishuBotMetadataPath(botId: string): string {
  return join(getConfigDir(), `feishu-metadata-${botId}.json`)
}

/**
 * 获取指定 Agent 会话的工作路径
 *
 * 在工作区目录下创建以 sessionId 命名的子文件夹，
 * 作为该会话的独立 Agent cwd。如果目录不存在则自动创建。
 *
 * @param workspaceSlug 工作区 slug
 * @param sessionId 会话 ID
 * @returns ~/.profer/agent-workspaces/{slug}/{sessionId}/
 */
export function getAgentSessionWorkspacePath(workspaceSlug: string, sessionId: string): string {
  const dir = join(getAgentWorkspacePath(workspaceSlug), sessionId)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 会话工作目录: ${dir}`)
  }

  return dir
}

/**
 * 获取 SDK 隔离配置目录路径
 *
 * 用于设置 CLAUDE_CONFIG_DIR 环境变量，让 SDK 读取独立的配置文件，
 * 而不是用户的 ~/.claude.json，实现 Profer 与 Claude Code CLI 的配置隔离。
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/.profer/sdk-config/
 */
export function getSdkConfigDir(): string {
  const dir = join(getConfigDir(), 'sdk-config')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 SDK 配置目录: ${dir}`)
  }

  return dir
}

/**
 * 获取 Scratch Pad 文件路径
 *
 * @returns ~/.profer/scratch-pad.md
 */
export function getScratchPadPath(): string {
  return join(getConfigDir(), 'scratch-pad.md')
}

/**
 * 获取定时任务（Automation）配置文件路径
 *
 * @returns ~/.profer/automations.json
 */
export function getAutomationsPath(): string {
  return join(getConfigDir(), 'automations.json')
}

/**
 * 获取新标签页起始页数据文件路径（书签 + 最近访问历史）
 *
 * @returns ~/.profer/browser-start-page.json
 */
export function getBrowserStartPagePath(): string {
  return join(getConfigDir(), 'browser-start-page.json')
}

/** 获取本地任务/日程（Planning）SQLite 数据库路径。 */
export function getPlanningDatabasePath(): string {
  return join(getConfigDir(), 'planning.db')
}

/**
 * 获取个人资料库（含历史论文）根目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/.profer/knowledge-base/
 */
export function getKnowledgeBaseDir(): string {
  const dir = join(getConfigDir(), 'knowledge-base')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建个人资料库目录: ${dir}`)
  }

  return dir
}

/** 通用个人资料索引；与历史论文 index.json 分开，避免迁移期间互相覆盖。 */
export function getKnowledgeItemsIndexPath(): string {
  return join(getKnowledgeBaseDir(), 'items-index.json')
}

/** 通用资料目录；普通资料与历史论文目录分离，避免路径和生命周期混用。 */
export function getKnowledgeItemsDir(): string {
  const dir = join(getKnowledgeBaseDir(), 'items')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 本地论文/资料目录只接受应用生成的 UUID，避免 renderer/损坏索引影响文件系统路径。 */
const LOCAL_PAPER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** 仅解析受控通用资料目录；读取和删除场景不得隐式创建路径。 */
export function resolveKnowledgeItemDir(itemId: string): string {
  if (typeof itemId !== 'string' || !LOCAL_PAPER_ID_RE.test(itemId)) {
    throw new Error('资料标识无效')
  }
  const root = resolve(getKnowledgeItemsDir())
  const dir = resolve(root, itemId)
  if (!dir.startsWith(`${root}${sep}`)) throw new Error('资料标识无效')
  return dir
}

/** 仅在导入通用资料的写入流程创建资料目录。 */
export function getKnowledgeItemDir(itemId: string): string {
  const dir = resolveKnowledgeItemDir(itemId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 获取设备身份文件路径
 *
 * @returns ~/.profer/device.json
 */
export function getDeviceIdentityPath(): string {
  return join(getConfigDir(), 'device.json')
}

/**
 * 获取团队服务器配置文件路径
 *
 * @returns ~/.profer/team-servers.json
 */
export function getTeamServersConfigPath(): string {
  return join(getConfigDir(), 'team-servers.json')
}

/**
 * 获取同步状态文件路径
 *
 * @returns ~/.profer/sync-state.json
 */
export function getSyncStatePath(): string {
  return join(getConfigDir(), 'sync-state.json')
}

/**
 * 获取团队 Skills 缓存目录路径
 *
 * @returns ~/.profer/team-skills-cache/
 */
export function getTeamSkillsCacheDir(): string {
  const dir = join(getConfigDir(), 'team-skills-cache')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}
