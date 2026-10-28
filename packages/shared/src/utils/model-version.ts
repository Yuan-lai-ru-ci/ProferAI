/**
 * 模型版本号比较 — 代际规则共用的小工具。
 *
 * 1M 上下文判定（context-window）与推理能力家族判定（reasoning-model-tag）
 * 都按「家族前缀 + 最低版本」做代际继承，必须用同一套解析，否则同一个模型
 * 在两处会得出不同的「第几代」结论。
 */

/** 把 "4.6" / "5-4" / "3.8-max" 这类版本串解析为可逐位比较的数字段。 */
export function parseVersionSegments(version: string): number[] {
  const segments: number[] = []
  for (const segment of version.split(/[.\-_]/)) {
    if (!/^\d+$/.test(segment)) break
    segments.push(Number(segment))
  }
  return segments
}

/** 逐位比较版本：缺失段按 0 处理，返回 a >= b。 */
export function isVersionAtLeast(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left > right
  }
  return true
}

/**
 * 从前缀之后取出可比较的版本串。
 *
 * 官方 ID 里前缀与版本之间有时带分隔符（`qwen-3.8-max`），有时不带（`qwen3.8-max`），
 * 这里统一去掉开头的分隔符，交给 parseVersionSegments 逐位比较。
 */
export function extractVersionAfterPrefix(modelId: string, prefix: string): number[] {
  if (!modelId.startsWith(prefix)) return []
  return parseVersionSegments(modelId.slice(prefix.length).replace(/^[.\-_]+/, ''))
}
