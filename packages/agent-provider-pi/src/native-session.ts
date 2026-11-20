import { existsSync, writeFileSync, renameSync, unlinkSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

/** 与桌面 SessionManager 主路径截断保持一致；只生成计划，宿主提交后才替换文件。 */
export async function preparePiNativeRewind(input: { file: string; sessionDir: string; cwd: string; entryId: string }) {
  const sdk = await import('@earendil-works/pi-coding-agent')
  const manager = sdk.SessionManager.open(input.file, input.sessionDir, input.cwd)
  if (!manager.getEntry(input.entryId)) throw new Error('Pi session 中找不到该 entry，无法回退')
  const entries = manager.getBranch(input.entryId)
  const content = [manager.getHeader(), ...entries].filter(Boolean).map(entry => JSON.stringify(entry)).join('\n') + '\n'
  return { entryIds: entries.map(entry => entry.id), content }
}

/** 复用桌面现有两步原生分叉：branch 到锚点，再 fork 到目标 cwd。 */
export async function forkPiNativeSession(input: { file: string; sessionDir: string; cwd: string; destinationDir: string; entryId: string }) {
  const sdk = await import('@earendil-works/pi-coding-agent')
  const source = sdk.SessionManager.open(input.file, input.sessionDir, input.cwd)
  if (!source.getEntry(input.entryId)) throw new Error('Pi session 中找不到分叉 entry')
  const branch = source.createBranchedSession(input.entryId)
  if (!branch || !existsSync(branch)) throw new Error('Pi 未能生成分叉 session artifact')
  const fork = sdk.SessionManager.forkFrom(branch, input.destinationDir, input.sessionDir)
  const file = fork.getSessionFile(), sessionId = fork.getSessionId()
  if (!file || !sessionId || !existsSync(file)) throw new Error('Pi 未能生成完整分叉 artifact')
  return { file, sessionId }
}

export function replacePiNativeTranscript(file: string, content: string): void {
  const temporary = `${file}.rewind-${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    const fd = openSync(temporary, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, file)
  } finally { if (existsSync(temporary)) unlinkSync(temporary) }
}
