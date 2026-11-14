/**
 * agent-file-write-chips.ts — 本轮「工具写了哪些文件」账本（消息气泡里的文件改动 chip）
 *
 * 旧链在 `agent-orchestrator` 里按 `toolCallId` 记下 Pi 上报的受控写入，`tool_result` 到达时
 * 把它挂到 block 的 `proferFileChanges` 上随消息落盘；渲染层 `TurnFileChangesSummary` 读它出 chip，
 * 会话历史回放也靠它恢复。
 *
 * 新链没有这段，于是消息气泡里看不到「改了哪些文件」，重启后连回放也没有。
 * 这里把展示记录搬过来，并保持展示与恢复证据分离：
 * - 只消费 provider 的受控写入或 chip-only 观察（`onFileWrite` / `onFileChangeObserved`），不解析命令文本；
 * - 本表只供消息展示，Bash 元数据差分不构成 Shadow 或 rewind 写入归属证据；
 * - 落点在 `provider-bridge` 的唯一出口，桌面与 headless 两条入口自动同时生效。
 */
import type { SDKMessage, SDKToolResultBlock } from '@profer/shared'

/** 一条 chip 展示记录：受控写入路径或低置信度的 Bash 目录变化观察。 */
export interface FileWriteChipFact {
  path: string
  source: string
}

interface FileWriteChipLedger {
  record(sessionId: string, toolUseId: string, fact: FileWriteChipFact): void
  /** 把命中的 tool_use 写入事实挂到 `tool_result` block 上；无命中时返回原对象 */
  attach(sessionId: string, message: SDKMessage): SDKMessage
  dropSession(sessionId: string): void
}

/**
 * 单会话最多留多少个「还没等到 tool_result」的工具调用。
 * 正常轮次挂载后立即删除，这里只是防止长期运行里失败/中断轮次无界累积。
 */
const MAX_PENDING_PER_SESSION = 256

export function createFileWriteChipLedger(): FileWriteChipLedger {
  const bySession = new Map<string, Map<string, FileWriteChipFact[]>>()

  function sessionMap(sessionId: string): Map<string, FileWriteChipFact[]> {
    let current = bySession.get(sessionId)
    if (!current) {
      current = new Map()
      bySession.set(sessionId, current)
    }
    return current
  }

  return {
    record(sessionId, toolUseId, fact) {
      if (!sessionId || !toolUseId || !fact.path) return
      const writes = sessionMap(sessionId)
      const existing = writes.get(toolUseId) ?? []
      // 同一工具调用对同一路径只记一次，避免多次上报生成重复 chip。
      if (existing.some(item => item.path === fact.path)) return
      writes.set(toolUseId, [...existing, fact])
      if (writes.size > MAX_PENDING_PER_SESSION) {
        const oldest = writes.keys().next()
        if (!oldest.done) writes.delete(oldest.value)
      }
    },

    attach(sessionId, message) {
      const writes = bySession.get(sessionId)
      if (!writes || writes.size === 0) return message
      if (message.type !== 'user') return message
      const blocks = (message as { message?: { content?: unknown } }).message?.content
      if (!Array.isArray(blocks)) return message

      let changed = false
      const nextBlocks = blocks.map((block) => {
        if (!block || typeof block !== 'object') return block
        if ((block as { type?: string }).type !== 'tool_result') return block
        const toolUseId = (block as { tool_use_id?: unknown }).tool_use_id
        if (typeof toolUseId !== 'string') return block
        const facts = writes.get(toolUseId)
        if (!facts?.length) return block
        // 已挂过就不重复挂（Provider 重发或消息被多次转发时保持幂等）。
        writes.delete(toolUseId)
        changed = true
        return { ...(block as SDKToolResultBlock), proferFileChanges: facts }
      })
      if (!changed) return message
      return {
        ...(message as { message: Record<string, unknown> }),
        message: { ...((message as { message: Record<string, unknown> }).message ?? {}), content: nextBlocks },
      } as SDKMessage
    },

    dropSession(sessionId) {
      bySession.delete(sessionId)
    },
  }
}

/** 主进程单例：宿主在准备阶段写入、在 provider 出口挂载，两边必须是同一张表。 */
export const fileWriteChips = createFileWriteChipLedger()
