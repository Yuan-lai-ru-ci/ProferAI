import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'

/** A version that was observed on disk, without pretending it is a recoverable backup. */
export type PiFileVersion =
  | { kind: 'absent'; revision: 'absent' }
  | { kind: 'file'; revision: string; sha256: string; size: number; mode?: number }

export type PiStoredFileVersion =
  | { kind: 'absent' }
  | { kind: 'file'; contentRef: string; sha256: string; size: number; mode?: number }

export interface PiFileVersionCapture {
  version?: PiFileVersion
  /** The bytes are kept only for the host-side backup writer; never serialized by the provider. */
  content?: Uint8Array
  reason?: string
}

export type PiFileMutationStatus = 'complete' | 'unsupported'

export interface PiFileMutationEvidence {
  path: string
  source: 'write' | 'edit' | 'bash'
  toolCallId: string
  before?: PiFileVersion
  after?: PiFileVersion
  beforeBackup?: PiStoredFileVersion
  afterBackup?: PiStoredFileVersion
  /** Host-provided ownership scope. Missing means the evidence is not safe to restore. */
  rootId?: string
  relativePath?: string
  coverage?: 'managed' | 'project'
  beforeContent?: Uint8Array
  afterContent?: Uint8Array
  evidence: 'controlled-write'
  status: PiFileMutationStatus
  reason?: string
  completedAt: number
}

/**
 * Capture one path only. This intentionally never walks a parent directory, so project
 * sessions do not pay for a repository-wide scan and unrelated files cannot enter evidence.
 */
export async function capturePiFileVersion(path: string): Promise<PiFileVersionCapture> {
  let info
  try {
    info = await stat(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { version: { kind: 'absent', revision: 'absent' } }
    return { reason: `无法读取文件状态 (${code ?? 'unknown'})` }
  }

  if (!info.isFile()) return { reason: '写入目标不是普通文件' }
  try {
    const content = await readFile(path)
    const sha256 = createHash('sha256').update(content).digest('hex')
    return {
      version: {
        kind: 'file',
        revision: `sha256:${sha256}`,
        sha256,
        size: content.byteLength,
        mode: info.mode,
      },
      content,
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return { reason: `无法读取文件内容 (${code ?? 'unknown'})` }
  }
}

export interface CapturePiFileMutationInput {
  path: string
  source: 'write' | 'edit' | 'bash'
  toolCallId: string
  write(): Promise<void>
  onMutation?: (evidence: PiFileMutationEvidence) => void | Promise<void>
}

/**
 * Run a controlled write with before/after evidence. Capture and observer failures are
 * deliberately converted into unsupported evidence; the actual model write still wins.
 */
export async function runWithPiFileMutationEvidence(input: CapturePiFileMutationInput): Promise<void> {
  let before: PiFileVersionCapture
  try {
    before = await capturePiFileVersion(input.path)
  } catch (error) {
    before = { reason: `写入前版本采集失败 (${error instanceof Error ? error.message : String(error)})` }
  }

  // The write itself is the primary operation. Evidence is best-effort around it.
  await input.write()

  let after: PiFileVersionCapture
  try {
    after = await capturePiFileVersion(input.path)
  } catch (error) {
    after = { reason: `写入后版本采集失败 (${error instanceof Error ? error.message : String(error)})` }
  }
  const reason = before.reason ?? after.reason
  const complete = before.version !== undefined && after.version !== undefined
  const evidence: PiFileMutationEvidence = {
    path: input.path,
    source: input.source,
    toolCallId: input.toolCallId,
    ...(before.version ? { before: before.version } : {}),
    ...(after.version ? { after: after.version } : {}),
    // absent 不能靠「空 Uint8Array」表达：宿主按真值判断内容是否存在，空数组也是真值，
    // 会被写成一个「存在但内容为空」的 before 版本，进而把新建文件误判成 preexisting，
    // 回退时拒绝删除。absent 只用 `before/after.kind` 表达。
    ...(before.version?.kind === 'file' && before.content ? { beforeContent: before.content } : {}),
    ...(after.version?.kind === 'file' && after.content ? { afterContent: after.content } : {}),
    evidence: 'controlled-write',
    status: complete ? 'complete' : 'unsupported',
    ...(!complete ? { reason: reason ?? '受控写入前后版本不完整' } : {}),
    completedAt: Date.now(),
  }
  try {
    await input.onMutation?.(evidence)
  } catch {
    // Recording is best effort and must never turn a successful model write into a failure.
  }
}
