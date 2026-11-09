/**
 * 回退结果的「不可见上下文」。
 *
 * 回退把对话截断到更早的位置，但工作区里可能仍有**属于用户自己的改动**被保留
 * （三方合并冲突、用户已经改过同一文件、文件本来就是用户建的）。模型看不到这些动作，
 * 如果它按「回退前自己写了什么」继续推理，就会在不存在的假设上工作——这是 Phase 5
 * 要补的最后一段：把「哪些文件没被撤销」作为一次性事实告诉下一轮。
 *
 * 三条硬约束：
 * 1. **不写入对话**：只拼进本轮 runtime prompt，Profer 的 JSONL / UI 里看不到；
 * 2. **只描述事实**：不解释冲突原因、不要求用户决策、不出现内部词；
 * 3. **一次即弃**：下一轮真正接上 provider 后才清除（见 agent-orchestrator 的 pendingRewindState）。
 */

import type { AgentRewindNotice, RewindResult } from '@profer/shared'

/** notice 里最多列出多少个保留文件；超出只给数量，避免提示词被大目录撑爆。 */
export const MAX_REWIND_NOTICE_PATHS = 20

/** 单条路径的最大长度；异常长路径只用于诊断，不该占满上下文。 */
const MAX_PATH_CHARS = 300

/** 路径清洗：去掉换行/回车与首尾空白，避免破坏标签结构。 */
function cleanPath(path: string): string | undefined {
  const cleaned = path.replace(/[\r\n\t]+/gu, ' ').trim()
  if (!cleaned) return undefined
  return cleaned.length > MAX_PATH_CHARS ? `${cleaned.slice(0, MAX_PATH_CHARS)}…` : cleaned
}

/**
 * 从一次成功的回退结果生成 notice。
 *
 * 只处理 `committed`：`recovery-required` 的语义是「没撤完，需要恢复」，不能给模型
 * 一个「已经回到某个干净状态」的错误前提。没有任何文件事实时返回 undefined——
 * 纯对话回退不需要额外提示，注入反而会干扰模型。
 */
export function createAgentRewindNotice(result: RewindResult, now = Date.now()): AgentRewindNotice | undefined {
  if (result.status !== 'committed' || !result.files) return undefined
  const keptPaths = [...new Set(result.files.conflicts.map(cleanPath).filter((path): path is string => Boolean(path)))]
    .sort((left, right) => left.localeCompare(right))
  const restoredCount = result.files.restored.length
  const deletedCount = result.files.deleted.length
  if (restoredCount === 0 && deletedCount === 0 && keptPaths.length === 0) return undefined
  return {
    createdAt: now,
    mode: result.mode,
    restoredCount,
    deletedCount,
    keptPaths: keptPaths.slice(0, MAX_REWIND_NOTICE_PATHS),
    keptCount: keptPaths.length,
  }
}

/**
 * 把 notice 渲染成模型可读的隐藏段落。
 *
 * 用独立标签包住，模型容易识别「这是环境事实，不是用户发言」；标签外的正文保持不变，
 * 让用户消息仍然是「最后一段」。内容刻意只说三件事：回退发生过、哪些文件被保留、以磁盘为准。
 */
export function buildRewindNoticePrompt(notice: AgentRewindNotice): string {
  const lines: string[] = ['<workspace_rewind_notice>', '上一轮对话与文件改动已回退到更早的位置。']
  const reverted: string[] = []
  if (notice.restoredCount > 0) reverted.push(`恢复 ${notice.restoredCount} 个被改动的文件`)
  if (notice.deletedCount > 0) reverted.push(`删除 ${notice.deletedCount} 个当时新建的文件`)
  if (reverted.length > 0) lines.push(`已撤销：${reverted.join('，')}。`)

  if (notice.keptCount > 0) {
    lines.push('以下文件未能安全撤销，已保持原样（可能包含用户自己的修改，或无法安全合并）：')
    for (const path of notice.keptPaths) lines.push(`- ${path}`)
    const omitted = notice.keptCount - notice.keptPaths.length
    if (omitted > 0) lines.push(`- …另有 ${omitted} 个文件`)
    lines.push('请以磁盘上的当前内容为准：不要假设这些文件仍是回退前的版本，也不要把保留的内容当成你自己的写入。')
  }
  lines.push('</workspace_rewind_notice>')
  return lines.join('\n')
}
