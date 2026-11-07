/**
 * 画像 → 提示词文本的投影。
 *
 * 为什么单独一层：同一个「用户名 + 记忆索引」在三个地方要出现——
 * Electron 的 agent 系统提示词、Electron 的每条消息动态上下文、CLI 的
 * `profer profile context`。三处各写一遍字符串，迟早会漂移成三种措辞。
 * 这里只做纯字符串拼接，不读盘、不依赖运行时。
 */

/** 转义会破坏 XML 风格标签边界的字符。 */
export function escapeContextText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 跨工作区用户记忆索引块（注入到每条消息的动态上下文）。 */
export function buildGlobalMemoryIndexBlock(memoryIndex: string): string {
  const index = memoryIndex.trim()
  if (!index) return ''
  return `<global_user_memory_index>
这是跨工作区共享的用户级记忆索引。仅按需搜索并读取主题正文；动态信息需与用户当轮信息核对。
${escapeContextText(index)}
</global_user_memory_index>`
}

/** 用户身份小节（注入到系统提示词）。 */
export function buildUserIdentitySection(userName: string): string {
  return `## 用户信息

- 用户名: ${userName || '用户'}`
}

export interface UserContextInput {
  /** 用户名；缺省时用「用户」。 */
  userName?: string
  /** `global-memory/MEMORY.md` 的正文；缺省或为空时跳过索引块。 */
  memoryIndex?: string
}

/**
 * 完整画像上下文（身份 + 记忆索引）。
 *
 * 供 CLI 与任何不带 UI 的宿主一次性取用：
 *   profer profile context  →  可直接拼进 system prompt 的文本
 */
export function buildUserContext(input: UserContextInput): string {
  const parts = [buildUserIdentitySection(input.userName ?? '')]
  const indexBlock = buildGlobalMemoryIndexBlock(input.memoryIndex ?? '')
  if (indexBlock) parts.push(indexBlock)
  return parts.join('\n\n')
}
