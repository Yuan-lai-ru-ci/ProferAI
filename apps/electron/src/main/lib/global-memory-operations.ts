import { appendGlobalMemoryFile, readGlobalMemoryFile } from './global-memory-service'

export const GLOBAL_MEMORY_APPEND_DESCRIPTION = '主动沉淀跨工作区用户记忆：profile 为用户明确透露的背景，preferences 为稳定偏好，inference 为至少两个不同会话重复出现的高置信度推断。写前搜索/读取主题去重，entry 只写一条简洁结论；推断须提供 evidence（不同 sessionId、日期、具体依据）和 confidence=high，不得编造证据。禁止凭据、敏感信息、第三方个人信息、临时状态或项目专属事实。成功后简短告知用户，可在我的画像中查看和编辑。'

export interface GlobalMemoryEvidence {
  sessionId: string
  date: string
  observation: string
}
export interface GlobalMemoryEntry {
  category: 'profile' | 'preferences' | 'inference'
  entry: string
  confidence?: 'high'
  evidence?: GlobalMemoryEvidence[]
}
const MEMORY_PATHS = {
  profile: 'user-profile.md',
  preferences: 'preferences.md',
  inference: 'user-sense.md',
} as const

/** Claude/Pi 共用写入操作；不接受任意路径或整份文档覆盖。 */
export function appendGlobalMemoryEntry(input: GlobalMemoryEntry): { path: string; added: boolean } {
  if (!Object.prototype.hasOwnProperty.call(MEMORY_PATHS, input.category)) throw new Error('未知记忆类别')
  if (typeof input.entry !== 'string' || input.entry.trim().length < 3 || input.entry.length > 2000 || /[\r\n]/.test(input.entry)) {
    throw new Error('记忆必须是一条 3–2000 字符的单行结论')
  }
  const path = MEMORY_PATHS[input.category]
  const entry = input.entry.trim().replace(/^[-*]\s+/, '')
  // 用户删除的主题不自动恢复；也避免将旧结论另起一份重复画像。
  const current = readGlobalMemoryFile(path).content ?? ''
  if (current.toLocaleLowerCase().includes(entry.toLocaleLowerCase())) return { path, added: false }
  let text = `- ${entry}`
  if (input.category === 'inference') {
    const evidence = input.evidence ?? []
    if (input.confidence !== 'high' || evidence.length < 2 || evidence.length > 5
      || evidence.some(item => !item.sessionId?.trim() || item.sessionId.length > 200
        || !/^\d{4}-\d{2}-\d{2}$/.test(item.date) || Number.isNaN(Date.parse(item.date))
        || !item.observation?.trim() || item.observation.length > 300
        || /[\r\n]/.test(item.sessionId + item.observation))
      || new Set(evidence.map(item => item.sessionId.trim())).size < 2) {
      throw new Error('推断须 confidence=high，且提供至少两个不同会话的日期与具体依据')
    }
    text = `- [推断] ${entry}\n  - 置信度：高；记录日期：${new Date().toISOString().slice(0, 10)}（UTC）\n${evidence.map(item => `  - 来源：${item.sessionId.trim()}；日期：${item.date}；依据：${item.observation.trim()}`).join('\n')}`
  }
  return { path, ...appendGlobalMemoryFile(path, text) }
}
