/**
 * TurnFileChangesSummary — Turn 底部文件改动汇总
 *
 * 在 AssistantTurnRenderer 的 MessageActions 之上，以 chip 横排展示本轮所有
 * 修改类工具调用（Edit / Write / MultiEdit / NotebookEdit）所触及的文件。
 *
 * 子代理（Agent/Task）的修改也会冒泡到此处——因为 SDK 的子代理 assistant
 * 消息同样存在于 turn.turnMessages 中（通过 parent_tool_use_id 关联）。
 *
 * 文件 chip 直接复用 FilePathChip（与 Agent 消息中的渲染完全一致）。
 */

import * as React from 'react'
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKToolUseBlock,
  SDKToolResultBlock,
} from '@profer/shared'
import { FilePathChip } from '@/components/ai-elements/file-path-chip'
import { getFileBaseName } from '@/lib/file-utils'

// Claude Code 用 Edit/Write/...；Pi runtime 内置工具名是小写 edit/write/...。
// 两套名字都要收进来，否则 Pi 会话的文件改动汇总永远是空的。
const MUTATING_TOOLS = new Set([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
  'edit', 'write', 'multi_edit', 'multiEdit', 'notebook_edit', 'notebookEdit',
])

/**
 * 本轮实际触及的文件：除改动类工具外也纳入 Read，供正文中裸文件名补全绝对路径。
 * Grep/Glob 的命中文件只存在于结果文本中，无法安全地归入此映射。
 */
const READ_TOOLS = new Set(['Read', 'read'])
const TOUCHED_TOOLS = new Set([...MUTATING_TOOLS, ...READ_TOOLS])

function getFilePath(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'NotebookEdit' || toolName === 'notebook_edit' || toolName === 'notebookEdit') {
    const fp = input.notebook_path ?? input.notebookPath ?? input.path
    return typeof fp === 'string' ? fp : null
  }
  const fp = input.file_path ?? input.filePath ?? input.path
  return typeof fp === 'string' ? fp : null
}

function collectFilePaths(turnMessages: SDKMessage[], tools: Set<string> = MUTATING_TOOLS): string[] {
  const failed = new Set<string>()
  for (const msg of turnMessages) {
    if (msg.type !== 'user') continue
    const blocks = (msg as SDKUserMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue
      const rb = block as SDKToolResultBlock
      if (rb.is_error === true) failed.add(rb.tool_use_id)
    }
  }

  const seen = new Set<string>()
  const paths: string[] = []
  for (const msg of turnMessages) {
    if (msg.type !== 'assistant') continue
    const blocks = (msg as SDKAssistantMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue
      const tu = block as SDKToolUseBlock
      if (failed.has(tu.id)) continue
      if (tu.name === 'Bash' || tu.name === 'bash' || tu.name === 'PowerShell') {
        const command = (tu.input as Record<string, unknown>)?.command
        if (typeof command === 'string') {
          for (const filePath of extractBashWritePaths(command)) {
            if (seen.has(filePath)) continue
            seen.add(filePath)
            paths.push(filePath)
          }
        }
        continue
      }
      if (!tools.has(tu.name)) continue

      const filePath = getFilePath(tu.name, tu.input as Record<string, unknown>)
      if (!filePath || seen.has(filePath)) continue
      seen.add(filePath)
      paths.push(filePath)
    }
  }
  return paths
}

/** 本轮修改类工具触及的文件（按出现顺序去重，失败调用已排除）。 */
export function collectModifiedFilePaths(turnMessages: SDKMessage[]): string[] {
  return collectFilePaths(turnMessages)
}

/**
 * 构建「文件名 → 绝对路径」映射，供 Assistant turn 正文的行内文件引用使用。
 * 同名文件无法仅凭裸文件名区分，因此直接剔除，维持既有 basePaths 降级解析，避免误预览。
 */
export function buildTurnFileNameMap(turnMessages: SDKMessage[]): Map<string, string> {
  const paths = collectFilePaths(turnMessages, TOUCHED_TOOLS)
  const map = new Map<string, string>()
  const conflicted = new Set<string>()

  for (const filePath of paths) {
    const filename = getFileBaseName(filePath)
    if (conflicted.has(filename)) continue

    const existing = map.get(filename)
    if (existing && existing !== filePath) {
      map.delete(filename)
      conflicted.add(filename)
      continue
    }
    map.set(filename, filePath)
  }

  return map
}


/**
 * Bash 写入命令的保守兜底。
 *
 * TurnFileChangesSummary 的正路是 Edit/Write 工具；但 Pi/Kimi 等运行时会用
 * `python3 - <<'PY' ... Path('x').write_text(...)` / `sed -i` / `cat >` 改文件。
 * 这里只在命令明确包含写入语义时提取路径，用于让这些轮次也能显示 chip。
 * 复杂 shell 仍以主进程按轮落盘账本为准（后续 C 方案）。
 */
const BASH_WRITE_HINT = /write_text\s*\(|write_bytes\s*\(|writeFileSync\s*\(|writeFile\s*\(|appendFileSync\s*\(|open\s*\([^)]*['"][wa]|sed\s+[^\n;]*-i|perl\s+[^\n;]*-[a-z]*i|tee\s+|cat\s+[^|;\n]*>|>{1,2}\s*[^>\s]|Set-Content\b|Out-File\b|apply_patch\b/i

function extractCdDirectory(command: string): string | null {
  const match = command.match(/(?:^|\n|&&|;)\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/)
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null
}

function resolveCommandPath(raw: string, cdDir: string | null): string | null {
  const path = raw.trim().replace(/^["']|["']$/g, '')
  if (!path || path.startsWith('-') || path.startsWith('$') || path.startsWith('&') || path.includes('://')) return null
  if (path.startsWith('/dev/') || path === '/dev/null') return null
  if (path.includes('/node_modules/') || path.includes('/.git/')) return null
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/')) return path.replace(/\\/g, '/')
  if (!cdDir) return path
  return `${cdDir.replace(/[\\/]+$/, '')}/${path}`.replace(/\/+/g, '/')
}

function lastCommandPathToken(tail: string): string | null {
  const tokens = tail.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]!.replace(/^["']|["']$/g, '')
    if (!token || token.startsWith('-') || token.startsWith('$')) continue
    // sed/perl 的表达式（s/a/b/）不是路径。
    if (/^[smy]?[\/|#]/.test(token)) continue
    if (token.includes('/') || /\.[A-Za-z0-9]+$/.test(token)) return token
  }
  return null
}

/** 从 Bash/PowerShell 命令中提取明确写入的文件路径；无法确定时返回空数组。 */
export function extractBashWritePaths(command: string): string[] {
  if (!command || !BASH_WRITE_HINT.test(command)) return []
  const cdDir = extractCdDirectory(command)
  const found: string[] = []
  const push = (raw: string | null): void => {
    if (!raw) return
    const resolved = resolveCommandPath(raw, cdDir)
    if (resolved && !found.includes(resolved)) found.push(resolved)
  }

  // python / node 写文件：只在命令含写入语义时提取 Path()/open(...,'w')/writeFileSync。
  for (const match of command.matchAll(/Path\(\s*['"]([^'"]+)['"]\s*\)/g)) push(match[1] ?? null)
  for (const match of command.matchAll(/open\(\s*['"]([^'"]+)['"]\s*,\s*['"][wa]/g)) push(match[1] ?? null)
  for (const match of command.matchAll(/(?:writeFileSync|writeFile|appendFileSync)\(\s*['"]([^'"]+)['"]/g)) push(match[1] ?? null)

  // sed -i / perl -pi：取命令尾部最后一个像路径的 token。
  for (const match of command.matchAll(/\bsed\s+(?:-[^\s]*i[^\s]*|--in-place(?:=\S+)?)\b([^\n;]*)/g)) push(lastCommandPathToken(match[1] ?? ''))
  for (const match of command.matchAll(/\bperl\s+[^\n;]*?\s-[a-zA-Z]*i[a-zA-Z]*\b([^\n;]*)/g)) push(lastCommandPathToken(match[1] ?? ''))

  // cat > file / tee file
  for (const match of command.matchAll(/(?:^|[^>])>{1,2}\s*['"]?([^'"\s|;&]+)/g)) push(match[1] ?? null)
  for (const match of command.matchAll(/\btee\s+(?:-[^\s]+\s+)*['"]?([^'"\s|;&]+)/g)) push(match[1] ?? null)

  // apply_patch 的文件头
  for (const match of command.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)) push(match[1] ?? null)

  return found
}

export interface TurnFileChangesSummaryProps {
  turnMessages: SDKMessage[]
  basePath?: string
}

export function TurnFileChangesSummary({
  turnMessages,
  basePath,
}: TurnFileChangesSummaryProps): React.ReactElement | null {
  const paths = React.useMemo(() => collectFilePaths(turnMessages), [turnMessages])

  return (
    <div className="file-changes-summary pl-[46px] mt-3">
      <div className="pt-3 border-t-2 border-dashed border-border/60">
        {paths.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {paths.map((filePath) => (
              <FilePathChip key={filePath} filePath={filePath} basePath={basePath} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
