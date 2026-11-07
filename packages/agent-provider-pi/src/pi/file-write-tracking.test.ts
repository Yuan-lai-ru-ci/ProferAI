import { describe, expect, test } from 'bun:test'
import * as sdk from '@earendil-works/pi-coding-agent'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBuiltinToolDefinitions, type FileWriteFact } from '../pi-agent-adapter'

const canUseTool = (async () => ({ behavior: 'allow' })) as never

function buildTools(
  cwd: string,
  onFileWrite: (toolCallId: string, fact: FileWriteFact) => void,
  onFileMutation?: (fact: import('../pi/rewind-evidence').PiFileMutationEvidence) => void | Promise<void>,
) {
  return buildBuiltinToolDefinitions(
    sdk,
    'test-session',
    cwd,
    canUseTool,
    { shellPath: '/bin/bash', shellKind: 'bash' } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    onFileWrite,
    onFileMutation,
  )
}

describe('Pi 受控写入上报', () => {
  test('write 工具落盘后上报路径', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profer-write-fact-'))
    try {
      const facts: Array<{ toolCallId: string; fact: FileWriteFact }> = []
      const write = buildTools(dir, (toolCallId, fact) => facts.push({ toolCallId, fact }))
        .find((tool) => tool.name === 'write')
      expect(write).toBeDefined()

      const target = join(dir, 'note.md')
      await write!.execute('call-1', { path: target, content: 'hello' } as never, undefined, undefined, undefined as never)

      expect(readFileSync(target, 'utf-8')).toBe('hello')
      expect(facts).toEqual([{ toolCallId: 'call-1', fact: { path: target, source: 'write' } }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('edit 工具改写后上报路径', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profer-edit-fact-'))
    try {
      const target = join(dir, 'note.md')
      writeFileSync(target, 'hello world', 'utf-8')

      const facts: Array<{ toolCallId: string; fact: FileWriteFact }> = []
      const edit = buildTools(dir, (toolCallId, fact) => facts.push({ toolCallId, fact }))
        .find((tool) => tool.name === 'edit')
      expect(edit).toBeDefined()

      await edit!.execute(
        'call-2',
        { path: target, edits: [{ oldText: 'world', newText: 'profer' }] } as never,
        undefined,
        undefined,
        undefined as never,
      )

      expect(readFileSync(target, 'utf-8')).toBe('hello profer')
      expect(facts).toEqual([{ toolCallId: 'call-2', fact: { path: target, source: 'edit' } }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('受控 write/edit 记录同一 tool call 的 before 与 after 版本', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profer-mutation-fact-'))
    try {
      const target = join(dir, 'tracked.md')
      writeFileSync(target, 'before', 'utf-8')
      const mutations: Array<import('../pi/rewind-evidence').PiFileMutationEvidence> = []
      const edit = buildTools(dir, () => {}, fact => { mutations.push(fact) })
        .find((tool) => tool.name === 'edit')!

      await edit.execute(
        'call-versioned',
        { path: target, edits: [{ oldText: 'before', newText: 'after' }] } as never,
        undefined,
        undefined,
        undefined as never,
      )

      expect(mutations).toHaveLength(1)
      expect(mutations[0]).toMatchObject({
        path: target,
        toolCallId: 'call-versioned',
        source: 'edit',
        evidence: 'controlled-write',
        status: 'complete',
        after: { kind: 'file', sha256: expect.any(String) },
        beforeContent: new Uint8Array(Buffer.from('before')),
        afterContent: new Uint8Array(Buffer.from('after')),
      })
      expect(mutations[0]?.before?.revision).not.toBe(mutations[0]?.after?.revision)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('证据回调失败不影响模型写入', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profer-mutation-observer-fail-'))
    try {
      const target = join(dir, 'note.md')
      const write = buildTools(dir, () => {}, () => { throw new Error('observer failed') })
        .find((tool) => tool.name === 'write')!
      await write.execute('call-observer-fail', { path: target, content: 'still written' } as never, undefined, undefined, undefined as never)
      expect(readFileSync(target, 'utf-8')).toBe('still written')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('写盘失败时不上报', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profer-write-fail-'))
    try {
      const facts: Array<{ toolCallId: string; fact: FileWriteFact }> = []
      const write = buildTools(dir, (toolCallId, fact) => facts.push({ toolCallId, fact }))
        .find((tool) => tool.name === 'write')!

      // 父目录不存在：Profer 的严格 write operations 会拒绝，不应产生写入事实。
      await expect(
        write.execute(
          'call-3',
          { path: join(dir, 'missing', 'note.md'), content: 'x' } as never,
          undefined,
          undefined,
          undefined as never,
        ),
      ).rejects.toThrow()

      expect(facts).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Bash 写入归属边界', () => {
  test('bash 命令生成的文件不会被目录 diff 自动归属', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profer-bash-fact-'))
    try {
      const facts: Array<{ toolCallId: string; fact: FileWriteFact }> = []
      const bash = buildTools(dir, (toolCallId, fact) => facts.push({ toolCallId, fact }))
        .find((tool) => tool.name === 'bash')
      expect(bash).toBeDefined()

      await bash!.execute(
        'call-4',
        { command: "python3 -c \"open('report.md','w').write('generated')\"" } as never,
        undefined,
        undefined,
        undefined as never,
      )

      expect(facts).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
