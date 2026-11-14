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
  onFileChangeObserved?: (toolCallId: string, fact: FileWriteFact) => void,
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
    onFileChangeObserved,
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
  test('bash 写入只进入 chip observer，不进入受控写入或回退证据', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profer-bash-fact-'))
    try {
      const writes: Array<{ toolCallId: string; fact: FileWriteFact }> = []
      const observed: Array<{ toolCallId: string; fact: FileWriteFact }> = []
      const mutations: Array<import('../pi/rewind-evidence').PiFileMutationEvidence> = []
      const bash = buildTools(
        dir,
        (toolCallId, fact) => writes.push({ toolCallId, fact }),
        fact => { mutations.push(fact) },
        (toolCallId, fact) => observed.push({ toolCallId, fact }),
      ).find((tool) => tool.name === 'bash')!

      await bash.execute(
        'call-4',
        { command: "printf generated > report.md" } as never,
        undefined,
        undefined,
        undefined as never,
      )

      expect(readFileSync(join(dir, 'report.md'), 'utf-8')).toBe('generated')
      expect(observed).toEqual([{ toolCallId: 'call-4', fact: { path: join(dir, 'report.md'), source: 'bash' } }])
      expect(writes).toEqual([])
      expect(mutations).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('bash 非零退出仍上报已观察到的改动', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profer-bash-nonzero-'))
    try {
      const observed: Array<{ toolCallId: string; fact: FileWriteFact }> = []
      const bash = buildTools(dir, () => {}, undefined, (toolCallId, fact) => observed.push({ toolCallId, fact }))
        .find((tool) => tool.name === 'bash')!

      await expect(bash.execute(
        'call-nonzero',
        { command: "printf partial > partial.txt; exit 7" } as never,
        undefined,
        undefined,
        undefined as never,
      )).rejects.toThrow()

      expect(readFileSync(join(dir, 'partial.txt'), 'utf-8')).toBe('partial')
      expect(observed).toEqual([{ toolCallId: 'call-nonzero', fact: { path: join(dir, 'partial.txt'), source: 'bash' } }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('Bash observer 抛错不影响命令执行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profer-bash-observer-fail-'))
    try {
      const bash = buildTools(dir, () => {}, undefined, () => { throw new Error('observer failed') })
        .find((tool) => tool.name === 'bash')!

      await bash.execute(
        'call-observer-fail',
        { command: "printf yes > survives.txt" } as never,
        undefined,
        undefined,
        undefined as never,
      )
      expect(readFileSync(join(dir, 'survives.txt'), 'utf-8')).toBe('yes')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('缺少 observer 时无扫描回调', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profer-bash-no-observer-'))
    try {
      const writes: Array<{ toolCallId: string; fact: FileWriteFact }> = []
      const bash = buildTools(dir, (toolCallId, fact) => writes.push({ toolCallId, fact }))
        .find((tool) => tool.name === 'bash')!
      await bash.execute(
        'call-no-observer',
        { command: "printf x > ignored.txt" } as never,
        undefined,
        undefined,
        undefined as never,
      )
      expect(writes).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('真实 Bash 只读命令不产生文件观察', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profer-bash-readonly-command-'))
    try {
      const observed: Array<{ toolCallId: string; fact: FileWriteFact }> = []
      const mutations: Array<import('../pi/rewind-evidence').PiFileMutationEvidence> = []
      const bash = buildTools(
        dir,
        () => {},
        fact => { mutations.push(fact) },
        (toolCallId, fact) => observed.push({ toolCallId, fact }),
      ).find((tool) => tool.name === 'bash')!

      await bash.execute('call-readonly-command', { command: 'pwd && ls' } as never, undefined, undefined, undefined as never)

      expect(observed).toEqual([])
      expect(mutations).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('Bash 超时后不观察部分写入，也不产生 mutation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profer-bash-timeout-'))
    try {
      const observed: Array<{ toolCallId: string; fact: FileWriteFact }> = []
      const mutations: Array<import('../pi/rewind-evidence').PiFileMutationEvidence> = []
      const bash = buildTools(
        dir,
        () => {},
        fact => { mutations.push(fact) },
        (toolCallId, fact) => observed.push({ toolCallId, fact }),
      ).find((tool) => tool.name === 'bash')!

      await expect(bash.execute(
        'call-timeout',
        { command: 'printf partial > partial.txt; sleep 2', timeout: 0.1 } as never,
        undefined,
        undefined,
        undefined as never,
      )).rejects.toThrow()

      expect(readFileSync(join(dir, 'partial.txt'), 'utf-8')).toBe('partial')
      expect(observed).toEqual([])
      expect(mutations).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('Bash 取消后不观察部分写入，也不产生 mutation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profer-bash-abort-'))
    try {
      const observed: Array<{ toolCallId: string; fact: FileWriteFact }> = []
      const mutations: Array<import('../pi/rewind-evidence').PiFileMutationEvidence> = []
      const bash = buildTools(
        dir,
        () => {},
        fact => { mutations.push(fact) },
        (toolCallId, fact) => observed.push({ toolCallId, fact }),
      ).find((tool) => tool.name === 'bash')!
      const controller = new AbortController()

      const execution = bash.execute(
        'call-abort',
        { command: 'printf partial > partial.txt; sleep 2' } as never,
        controller.signal as never,
        undefined,
        undefined as never,
      )
      setTimeout(() => controller.abort(), 100).unref?.()
      await expect(execution).rejects.toThrow()

      expect(readFileSync(join(dir, 'partial.txt'), 'utf-8')).toBe('partial')
      expect(observed).toEqual([])
      expect(mutations).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('缺少 tool ID 时不报告 Bash 观察结果', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'profer-bash-no-id-'))
    try {
      const observed: Array<{ toolCallId: string; fact: FileWriteFact }> = []
      const mutations: Array<import('../pi/rewind-evidence').PiFileMutationEvidence> = []
      const bash = buildTools(dir, () => {}, fact => { mutations.push(fact) }, (toolCallId, fact) => observed.push({ toolCallId, fact }))
        .find((tool) => tool.name === 'bash')!
      await bash.execute(
        '',
        { command: "printf x > no-id.txt" } as never,
        undefined,
        undefined,
        undefined as never,
      )
      expect(observed).toEqual([])
      expect(mutations).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
