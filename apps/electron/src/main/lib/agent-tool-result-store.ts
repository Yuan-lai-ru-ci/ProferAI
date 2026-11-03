/**
 * 主进程工具结果落盘适配。
 *
 * 历史工具结果超出聚合预算时，完整内容写到 userData 下按会话分目录，
 * 消息里只留路径和预览；模型需要时再 `Read` 回来，不必重跑工具。
 *
 * 文件名用内容哈希，同一份内容重复落盘会命中同一路径，天然幂等；
 * 写失败返回 null，预算层保持原地截断，不阻断请求。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { PiToolResultPersistPort } from '@profer/agent-provider-pi'

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
  return cleaned.length > 0 ? cleaned : 'unknown'
}

/** 会话落盘目录；清理与会话删除共用同一路径推导，避免两边改名后对不上。 */
export function getToolResultDir(sessionId: string): string {
  return join(app.getPath('userData'), 'tool-results', safeSegment(sessionId))
}

/** 删除会话时级联清理；失败不阻断会话删除。 */
export function removeToolResultDir(sessionId: string): void {
  try {
    rmSync(getToolResultDir(sessionId), { recursive: true, force: true })
  } catch {
    /* 清理失败不阻断会话删除 */
  }
}

/** 异步版：会话删除路径避免同步递归删除阻塞主线程。 */
export async function removeToolResultDirAsync(sessionId: string): Promise<void> {
  try {
    await rm(getToolResultDir(sessionId), { recursive: true, force: true })
  } catch {
    /* 清理失败不阻断会话删除 */
  }
}

export function createElectronPiToolResultPersist(): PiToolResultPersistPort {
  return {
    persist({ sessionId, toolCallId, text, isJson }) {
      try {
        const dir = getToolResultDir(sessionId)
        mkdirSync(dir, { recursive: true })
        const hash = createHash('sha256').update(text).digest('hex').slice(0, 16)
        const path = join(dir, `${safeSegment(toolCallId)}-${hash}.${isJson ? 'json' : 'txt'}`)
        writeFileSync(path, text, 'utf8')
        return { path }
      } catch {
        return null
      }
    },
  }
}
