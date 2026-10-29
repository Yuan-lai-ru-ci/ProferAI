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

describe('Bash 写入快照兜底', () => {
  test('bash 命令生成的文件通过前后快照被识别', async () => {
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

      const written = facts.find((entry) => entry.fact.path === join(dir, 'report.md'))
      expect(written?.fact.source).toBe('bash')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
