import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWithPiFileMutationEvidence, type PiFileMutationEvidence } from './rewind-evidence'

async function mutate(path: string, write: () => void): Promise<PiFileMutationEvidence> {
  let captured: PiFileMutationEvidence | undefined
  await runWithPiFileMutationEvidence({
    path,
    source: 'write',
    toolCallId: 'tool-1',
    write: async () => { write() },
    onMutation: (evidence) => { captured = evidence },
  })
  if (!captured) throw new Error('没有采集到证据')
  return captured
}

describe('Pi 受控写入证据的 before/after 内容边界', () => {
  test('新建文件：absent 只用 kind 表达，不携带空内容', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-evidence-'))
    try {
      const path = join(dir, 'new.md')
      const evidence = await mutate(path, () => writeFileSync(path, 'hello'))
      expect(evidence.before).toEqual({ kind: 'absent', revision: 'absent' })
      // 空 Uint8Array 会被宿主当成「存在但为空」的版本 → 新建文件被误判成 preexisting。
      expect(evidence.beforeContent).toBeUndefined()
      expect(evidence.after?.kind).toBe('file')
      expect(Buffer.from(evidence.afterContent!).toString('utf8')).toBe('hello')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('已存在的空文件：beforeContent 仍然保留（长度 0，但它是真的文件）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-evidence-'))
    try {
      const path = join(dir, 'empty.md')
      writeFileSync(path, '')
      const evidence = await mutate(path, () => writeFileSync(path, 'filled'))
      expect(evidence.before?.kind).toBe('file')
      expect(evidence.beforeContent).toBeDefined()
      expect(evidence.beforeContent!.byteLength).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
