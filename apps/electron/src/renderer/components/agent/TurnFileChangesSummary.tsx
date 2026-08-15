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

const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * 本轮实际触及的文件：除改动类工具外也纳入 Read，供正文中裸文件名补全绝对路径。
 * Grep/Glob 的命中文件只存在于结果文本中，无法安全地归入此映射。
 */
const TOUCHED_TOOLS = new Set([...MUTATING_TOOLS, 'Read'])

function getFilePath(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'NotebookEdit') {
    const fp = input.notebook_path
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
      if (!tools.has(tu.name)) continue
      if (failed.has(tu.id)) continue

      const filePath = getFilePath(tu.name, tu.input as Record<string, unknown>)
      if (!filePath || seen.has(filePath)) continue
      seen.add(filePath)
      paths.push(filePath)
    }
  }
  return paths
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
  basePath?: string
}

export function TurnFileChangesSummary({
  turnMessages,
  basePath,
}: TurnFileChangesSummaryProps): React.ReactElement | null {
  const paths = React.useMemo(() => collectFilePaths(turnMessages), [turnMessages])

  if (paths.length === 0) return null

  return (
    <div className="file-changes-summary pl-[46px] mt-3">
      <div className="pt-3 border-t-2 border-dashed border-border/60">
        <div className="flex flex-wrap gap-1.5">
          {paths.map((filePath) => (
            <FilePathChip key={filePath} filePath={filePath} basePath={basePath} />
          ))}
        </div>
      </div>
    </div>
  )
}
