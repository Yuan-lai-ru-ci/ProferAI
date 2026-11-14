/**
 * TurnFileChangesSummary — Turn 底部文件改动汇总
 *
 * 数据源是主进程的「受控写入账本」：Pi 的 write/edit 在落盘后上报路径，
 * Bash 通过执行前后目录快照兜底；主进程把这些事实挂到对应 tool_result block 的
 * `proferFileChanges` 上，随消息一起落盘。
 *
 * 渲染层不再从命令文本推断路径——那正是过去产生 `<meta>` / `%{http_code}` /
 * `=` 这类假 chip 的根因。每次调用没有账本字段时，只回退到 Edit/Write 的
 * tool_use 参数；是否回退按 tool_use_id 判断，不能因为一条账本记录就丢掉整轮的其他修改。
 * Bash 命令文本始终不参与推断，避免生成假路径 chip。
 *
 * 子代理（Agent/Task）的修改也会冒泡到此处——因为 SDK 的子代理 assistant
 * 消息同样存在于 turn.turnMessages 中（通过 parent_tool_use_id 关联）。
 *
 * 文件 chip 直接复用 FilePathChip（与 Agent 消息中的渲染完全一致）。
 *
 * 会话草稿区（storageDir）内的写入不计入：截图、临时产物、`.context` 草稿都是 Agent 的草稿区产物，
 * 不是用户要 review 的改动。判定基准必须显式传入 `draftRoot`：project 下它不是 UI 根（项目根），
 * 而是中央 storageDir——拿项目根当基准会把项目内改动当成草稿丢弃，chip 变空。
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
import { getFileBaseName, isAbsoluteFilePath, isPathInsideDirectory } from '@/lib/file-utils'

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

/** 主进程挂在 tool_result block 上的写入事实。 */
interface ProferFileChange {
  path: string
  source: 'write' | 'edit' | 'bash'
}

function getFilePath(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'NotebookEdit' || toolName === 'notebook_edit' || toolName === 'notebookEdit') {
    const fp = input.notebook_path ?? input.notebookPath ?? input.path
    return typeof fp === 'string' ? fp : null
  }
  const fp = input.file_path ?? input.filePath ?? input.path
  return typeof fp === 'string' ? fp : null
}

/**
 * 读取主进程账本：本轮每个 tool_result 上挂的写入事实。
 *
 * 按 turnMessages 顺序去重，保留首次出现的位置，避免同一文件被多次编辑时
 * chip 重复。
 */
export function collectAuthoritativeFileChanges(turnMessages: SDKMessage[]): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const msg of turnMessages) {
    if (msg.type !== 'user') continue
    const blocks = (msg as SDKUserMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue
      const changes = (block as SDKToolResultBlock & { proferFileChanges?: ProferFileChange[] }).proferFileChanges
      if (!Array.isArray(changes)) continue
      for (const change of changes) {
        if (typeof change?.path !== 'string' || seen.has(change.path)) continue
        seen.add(change.path)
        paths.push(change.path)
      }
    }
  }
  return paths
}

function collectFilePaths(
  turnMessages: SDKMessage[],
  tools: Set<string> = MUTATING_TOOLS,
  coveredToolUseIds: ReadonlySet<string> = new Set(),
): string[] {
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
      if (failed.has(tu.id) || coveredToolUseIds.has(tu.id)) continue
      if (!tools.has(tu.name)) continue

      const filePath = getFilePath(tu.name, tu.input as Record<string, unknown>)
      if (!filePath || seen.has(filePath)) continue
      seen.add(filePath)
      paths.push(filePath)
    }
  }
  return paths
}

/**
 * 本轮修改类工具触及的文件（按出现顺序去重，失败调用已排除）。
 *
 * 每次调用优先用主进程账本；仅未被账本覆盖的 Edit/Write 回退到 tool_use 参数。
 * 空账本同样表示该调用已覆盖，不能把未发生的写入从参数重新补回。
 */
export function collectModifiedFilePaths(turnMessages: SDKMessage[]): string[] {
  const coveredToolUseIds = new Set<string>()
  for (const msg of turnMessages) {
    if (msg.type !== 'user') continue
    const blocks = (msg as SDKUserMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue
      const result = block as SDKToolResultBlock & { proferFileChanges?: ProferFileChange[] }
      if (Array.isArray(result.proferFileChanges)) coveredToolUseIds.add(result.tool_use_id)
    }
  }
  return [...new Set([
    ...collectAuthoritativeFileChanges(turnMessages),
    ...collectFilePaths(turnMessages, MUTATING_TOOLS, coveredToolUseIds),
  ])]
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

export interface TurnFileChangesSummaryProps {
  turnMessages: SDKMessage[]
  /** 相对路径解析基准（UI 根：managed = 会话目录，project = 项目根） */
  basePath?: string
  /**
   * 草稿区判定基准（显式传入的 storageDir）。
   *
   * 不能复用 `basePath`：project 下 `basePath` 是项目根，会把项目内改动全部当草稿隐藏。
   * 缺省（无工作区 / 拿不到 storageDir）时不做草稿过滤——宁可多显示也不整轮空白，
   * 且正常链路上主进程的写入账本已按 storageDir 在落账时就过滤过草稿。
   */
  draftRoot?: string
}

/**
 * 算出本轮要展示的文件改动 chip。
 *
 * 草稿区（`draftRoot`，即会话 storageDir）是 Agent 的临时产物落点：截图、临时文件、
 * `.context` 草稿全在那里，它们不是用户要 review 的改动，一律不追踪（历史会话里已落盘的旧记录同样过滤）。
 * project 下 storageDir 与 UI 根（项目根）互不相交，所以这两个参数不能混用。
 * 相对路径脱离 `draftRoot` 无法判断归属，保持可见。
 */
export function resolveVisibleFileChanges(
  paths: readonly string[],
  draftRoot?: string,
): string[] {
  if (!draftRoot) return [...paths]
  return paths.filter((path) => !isAbsoluteFilePath(path) || !isPathInsideDirectory(path, draftRoot))
}

export function TurnFileChangesSummary({
  turnMessages,
  basePath,
  draftRoot,
}: TurnFileChangesSummaryProps): React.ReactElement | null {
  const paths = React.useMemo(() => collectModifiedFilePaths(turnMessages), [turnMessages])
  const visiblePaths = resolveVisibleFileChanges(paths, draftRoot)

  return (
    <div className="file-changes-summary pl-[46px] mt-3">
      <div className="pt-3 border-t-2 border-dashed border-border/60">
        {visiblePaths.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {visiblePaths.map((filePath) => (
              <FilePathChip key={filePath} filePath={filePath} basePath={basePath} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
