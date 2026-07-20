/**
 * Paperpipe 本地 PDF 显式重试策略。
 * 仅将未附带 HTTP 状态的传输层错误以及 Bridge 的暂时性失败视为可重试。
 */
export function paperpipeErrorStatus(error: unknown): number | undefined {
  return typeof (error as { status?: unknown })?.status === 'number'
    ? (error as { status: number }).status
    : undefined
}

export function isRetryablePaperpipeSyncError(error: unknown): boolean {
  const status = paperpipeErrorStatus(error)
  return status == null || status === 502 || status === 504
}
