import { existsSync } from 'node:fs'

export interface PiForkedSession {
  getSessionFile(): string | undefined
  getSessionId(): string | undefined
  getEntry(entryId: string): unknown
  appendCustomMessageEntry(customType: string, content: string, display: boolean, details?: unknown): unknown
}

/**
 * 将 Pi SDK 的分叉调用限制在一个可替换边界内。
 *
 * Bun 的 mock.module() 是进程级且不可恢复的。会话管理器测试只需替换此边界，
 * 不应 mock 整个 @earendil-works/pi-coding-agent 包，否则会污染后续 SDK smoke /
 * model registry 测试。生产路径仍按原样使用 Pi 原生 SessionManager 分叉。
 */
export async function forkPiSessionArtifact(input: {
  sourceSessionFile: string
  sessionDir: string
  sourceDir?: string
  destinationDir?: string
  entryId: string
}): Promise<PiForkedSession> {
  const sdk = await import('@earendil-works/pi-coding-agent')
  const sourceManager = sdk.SessionManager.open(input.sourceSessionFile, input.sessionDir, input.sourceDir)
  const branchFile = sourceManager.createBranchedSession(input.entryId)
  if (!branchFile || !existsSync(branchFile)) {
    throw new Error('Pi 未能生成分叉 session artifact')
  }

  return sdk.SessionManager.forkFrom(
    branchFile,
    input.destinationDir ?? input.sourceDir ?? process.cwd(),
    input.sessionDir,
  )
}
