/**
 * 上下文占用率计算工具 — 主进程与渲染进程共用的纯函数。
 *
 * `usedTokens` 通常对应 SDK 在 `usage.input_tokens` 中返回的值
 * （已经包含 cache_read_input_tokens 和 cache_creation_input_tokens 部分），
 * 由 SDK 在 result 或 assistant message 的 usage 字段中提供。
 */

/**
 * 计算上下文占用率（0-1）。
 *
 * 任一输入无效（非有限数、缺失、非正）时返回 undefined。
 * 调用方应将 undefined 解释为「占用率未知」，而不是 0%——这通常意味着
 * session 还没有任何流式结果，或 contextWindow 无法推断，应保守处理。
 */
export function calculateContextUsageRatio(
  usedTokens: number | undefined,
  contextWindow: number | undefined,
): number | undefined {
  if (
    usedTokens === undefined ||
    contextWindow === undefined ||
    !Number.isFinite(usedTokens) ||
    !Number.isFinite(contextWindow) ||
    usedTokens < 0 ||
    contextWindow <= 0
  ) {
    return undefined
  }
  return usedTokens / contextWindow
}
