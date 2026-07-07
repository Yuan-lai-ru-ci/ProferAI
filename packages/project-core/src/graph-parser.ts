/**
 * graph-parser.ts — 任务描述元标记解析
 *
 * 解析 TaskCreate/TaskUpdate description 中的 @dependsOn、@artifact、@usage 标记。
 * 所有函数均为纯函数，无副作用，浏览器安全。
 */

// ===== 元标记解析 =====

/**
 * 从描述文本中解析 @dependsOn 标记。
 * 格式：@dependsOn: task-1, task-2, task-3
 */
export function parseDependsOn(text: string): string[] {
  const match = text.match(/@dependsOn:\s*([^\n]+)/i)
  if (!match || !match[1]) return []
  return match[1]
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

/**
 * 从描述文本中解析 @artifact 标记。
 * 格式：@artifact: src/auth/login.ts, src/auth/middleware.ts
 */
export function parseArtifact(text: string): string[] {
  const match = text.match(/@artifact:\s*([^\n]+)/i)
  if (!match || !match[1]) return []
  return match[1]
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

/**
 * 从描述文本中解析 @usage 标记。
 * 格式：@usage: tokens=1500, tools=5, duration=3200
 */
export function parseUsage(text: string): { totalTokens?: number; toolUses?: number; durationMs?: number } | null {
  const match = text.match(/@usage:\s*([^\n]+)/i)
  if (!match || !match[1]) return null
  const result: { totalTokens?: number; toolUses?: number; durationMs?: number } = {}
  for (const part of match[1].split(',')) {
    const [k, v] = part.split('=')
    if (k && v) {
      const key = k.trim()
      const val = parseInt(v.trim(), 10)
      if (!isNaN(val)) {
        if (key === 'tokens') result.totalTokens = val
        else if (key === 'tools') result.toolUses = val
        else if (key === 'duration') result.durationMs = val
      }
    }
  }
  return Object.keys(result).length > 0 ? result : null
}

/**
 * 从描述文本中解析 @forkFrom 标记。
 * 格式：@forkFrom: <原任务ID>
 */
export function parseForkFrom(text: string): string | null {
  const match = text.match(/@forkFrom:\s*([^\n]+)/i)
  return match?.[1]?.trim() ?? null
}

/** 需要从文本中清除的元标记模式 */
const META_TAG_PATTERN = /@(dependsOn|artifact|usage|forkFrom):\s*\S[^\n]*/gi

/**
 * 从描述文本中去除所有元标记（@dependsOn、@artifact、@usage、@forkFrom 等）。
 * 支持行首独立标记和行内标记两种形式：
 *   - 行首：整行以 @xxx: 开头 → 移除整行
 *   - 行内：文本后跟 @xxx: → 只移除标记部分
 * 保留其余内容作为纯净描述。
 */
export function stripMetaTags(text: string): string {
  return text
    .split('\n')
    .map(line => {
      // 先处理行首标记（整行移除）
      if (/^\s*@(dependsOn|artifact|usage|forkFrom):/i.test(line.trim())) {
        return ''
      }
      // 再清除行内标记
      return line.replace(META_TAG_PATTERN, '').replace(/\s+/g, ' ').trim()
    })
    .filter(line => line.length > 0)
    .join('\n')
    .trim()
}

