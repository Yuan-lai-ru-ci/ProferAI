/**
 * 优先使用本轮有效渠道；切换初始化短暂为空时保留最近稳定值，避免额度查询/工具栏闪烁。
 */
export function resolvePlanQuotaChannelId(
  currentChannelId: string | null | undefined,
  lastStableChannelId: string | null | undefined,
): string | undefined {
  return currentChannelId ?? lastStableChannelId ?? undefined
}
