import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, copyFileSync, mkdirSync, constants, writeFileSync, unlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { planClaudeFileRewind, type ClaudeHistoryEntry } from './native-file-rewind'
import { forkSession } from '@anthropic-ai/claude-agent-sdk'

export function claudeNativeProjectKey(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= 200) return sanitized
  let hash = 0
  for (let index = 0; index < cwd.length; index++) hash = (hash * 31 + cwd.charCodeAt(index)) | 0
  return `${sanitized.slice(0, 200)}-${Math.abs(hash).toString(36)}`
}

export function relocateClaudeNativeSession(input: { sdkConfigDir: string; sessionId: string; sourceCwd: string; destinationCwd: string }): string {
  const source = locateClaudeNativeSession(input.sdkConfigDir, input.sessionId)
  const destination = join(input.sdkConfigDir, 'projects', claudeNativeProjectKey(input.destinationCwd), `${input.sessionId}.jsonl`)
  mkdirSync(dirname(destination), { recursive: true })
  if (!inside(input.sdkConfigDir, dirname(destination))) throw new Error('Claude 目标 cwd 资产目录越界')
  const sourceCwd = input.sourceCwd.replace(/[\\/]+$/, ''), destinationCwd = input.destinationCwd.replace(/[\\/]+$/, '')
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') return sourceCwd ? value.split(sourceCwd).join(destinationCwd) : value
    if (Array.isArray(value)) return value.map(rewrite)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]))
    return value
  }
  const content = readFileSync(source, 'utf8').split('\n').filter(Boolean).map(line => JSON.stringify(rewrite(JSON.parse(line)))).join('\n') + '\n'
  if (source === destination) return source
  if (existsSync(destination)) {
    if (lstatSync(destination).isSymbolicLink() || readFileSync(destination, 'utf8') !== content) throw new Error('Claude cwd 迁移资产冲突')
  } else writeFileSync(destination, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  // 原文件仅在新文件完整写入后移除，防止同 ID 多个位置导致后续定位歧义。
  unlinkSync(source)
  return destination
}


export function validateClaudeNativeAnchor(sdkConfigDir: string, sessionId: string, messageId: string): void {
  const file = locateClaudeNativeSession(sdkConfigDir, sessionId)
  const entries = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { uuid?: string; type?: string; parentToolUseID?: string; parent_tool_use_id?: string })
  const anchor = entries.find(entry => entry.uuid === messageId)
  if (!anchor || anchor.type !== 'assistant' || anchor.parentToolUseID || anchor.parent_tool_use_id) throw new Error('Claude 回退锚点不是原生主线 assistant 消息')
}


function inside(root: string, file: string): boolean {
  const rel = relative(realpathSync(root), realpathSync(file))
  return Boolean(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)
}
/** 只搜索所属 Core 的 SDK 根，禁止 SDK 的跨配置全局回退。 */
export function locateClaudeNativeSession(sdkConfigDir: string, sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Claude 原生会话身份无效')
  const root = join(sdkConfigDir, 'projects'), matches: string[] = []
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const file = join(root, entry.name, `${sessionId}.jsonl`)
      if (existsSync(file) && inside(root, file)) matches.push(file)
    }
  }
  if (matches.length !== 1) throw new Error(matches.length ? 'Claude 原生会话身份重复' : '所属 Core 缺少 Claude 原生会话')
  return matches[0]!
}

/** SDK fork 使用进程级配置；宿主必须在启动时固定本 Core 的配置根，禁止临时改 env。 */
export async function forkClaudeNativeSession(input: { sdkConfigDir: string; sessionId: string; messageId: string; cwd: string }) {
  if (!process.env.CLAUDE_CONFIG_DIR || realpathSync(process.env.CLAUDE_CONFIG_DIR) !== realpathSync(input.sdkConfigDir)) {
    throw new Error('Claude SDK 配置根未绑定所属 Core，拒绝跨配置分叉')
  }
  const source = locateClaudeNativeSession(input.sdkConfigDir, input.sessionId)
  const messages = readFileSync(source, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { uuid?: string })
  if (!messages.some(message => message.uuid === input.messageId)) throw new Error('Claude 原生会话中没有目标消息')
  const result = await forkSession(input.sessionId, { upToMessageId: input.messageId, dir: input.cwd })
  return { sessionId: result.sessionId, file: locateClaudeNativeSession(input.sdkConfigDir, result.sessionId) }
}

/** 保留原生相对布局；只复制新资产，目标冲突拒绝，绝不覆盖另一 Core 的上下文。 */
export function importClaudeNativeAssets(input: { sourceRoot: string; destinationRoot: string; sessionId: string }) {
  const source = locateClaudeNativeSession(input.sourceRoot, input.sessionId)
  const relativeFile = relative(realpathSync(input.sourceRoot), realpathSync(source))
  const destination = join(input.destinationRoot, relativeFile)
  mkdirSync(dirname(destination), { recursive: true })
  if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) throw new Error('Claude 原生资产目标不能为链接')
  if (!inside(input.destinationRoot, dirname(destination))) throw new Error('Claude 资产目标路径越界')
  if (existsSync(destination)) {
    if (!readFileSync(destination).equals(readFileSync(source))) throw new Error('Claude 原生资产冲突，目标保留')
  } else copyFileSync(source, destination, constants.COPYFILE_EXCL)
  const history = join(input.sourceRoot, 'file-history', input.sessionId)
  if (existsSync(history)) {
    const copy = (from: string, to: string): void => {
      if (!inside(input.sourceRoot, from)) throw new Error('Claude 文件历史路径越界')
      mkdirSync(to, { recursive: true })
      if (!inside(input.destinationRoot, to)) throw new Error('Claude 文件历史目标路径越界')
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('Claude 文件历史包含链接')
        const sourceFile = join(from, entry.name), targetFile = join(to, entry.name)
        if (entry.isDirectory()) copy(sourceFile, targetFile)
        else if (entry.isFile()) {
          if (existsSync(targetFile) && lstatSync(targetFile).isSymbolicLink()) throw new Error('Claude 文件历史目标不能为链接')
          if (existsSync(targetFile)) {
            if (!readFileSync(targetFile).equals(readFileSync(sourceFile))) throw new Error('Claude 文件历史资产冲突')
          } else copyFileSync(sourceFile, targetFile, constants.COPYFILE_EXCL)
        }
      }
    }
    copy(history, join(input.destinationRoot, 'file-history', basename(history)))
  }
  return destination
}

/** 桌面现有“下一条真实 user 快照”规则；先完整校验，再执行文件恢复。 */
export function restoreClaudeNativeFiles(input: { sdkConfigDir: string; sessionId: string; messageId: string; cwd: string }) {
  const file = locateClaudeNativeSession(input.sdkConfigDir, input.sessionId)
  const entries = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as ClaudeHistoryEntry & { message?: { content?: unknown }; isMeta?: boolean })
  const index = entries.findIndex(entry => entry.uuid === input.messageId)
  if (index < 0) throw new Error('未找到 Claude 文件回退锚点')
  const next = entries.slice(index + 1).find(entry => entry.type === 'user' && !entry.isMeta
    && !(Array.isArray(entry.message?.content) && entry.message.content.some((part: unknown) => part && typeof part === 'object' && (part as { type?: string }).type === 'tool_result')))
  if (!next?.uuid) return { canRewind: true, filesChanged: [] as string[] }
  const plan = planClaudeFileRewind(entries, next.uuid)
  const root = realpathSync(input.cwd), history = join(input.sdkConfigDir, 'file-history', input.sessionId)
  const operations = [...plan].map(([path, backup]) => {
    const destination = isAbsolute(path) ? resolve(path) : resolve(root, path)
    const rel = relative(root, destination)
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..' + String.fromCharCode(92))) throw new Error('Claude 文件回退目标越界')
    // 不允许祖先目录链接把逻辑路径带离 cwd。
    let ancestor = destination
    while (!existsSync(ancestor)) ancestor = dirname(ancestor)
    if (ancestor !== root && !inside(root, ancestor)) throw new Error('Claude 文件回退目标链接越界')
    if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) throw new Error('Claude 文件回退目标不能为链接')
    if (backup === null) return { destination, path, content: undefined }
    const source = resolve(history, backup)
    if (!existsSync(source) || !inside(history, source)) throw new Error('Claude 文件备份缺失或越界')
    return { destination, path, content: readFileSync(source) }
  })
  const originals = operations.map(operation => existsSync(operation.destination) ? readFileSync(operation.destination) : undefined)
  try {
    for (const operation of operations) {
      if (operation.content === undefined) { if (existsSync(operation.destination)) unlinkSync(operation.destination) }
      else { mkdirSync(dirname(operation.destination), { recursive: true }); writeFileSync(operation.destination, operation.content) }
    }
  } catch (error) {
    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index]!, original = originals[index]
      if (original === undefined) { if (existsSync(operation.destination)) unlinkSync(operation.destination) }
      else writeFileSync(operation.destination, original)
    }
    throw error
  }
  return { canRewind: true, filesChanged: operations.map(operation => operation.path) }
}
