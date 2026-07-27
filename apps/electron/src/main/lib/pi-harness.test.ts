import { describe, expect, test } from 'bun:test'
import { createPiHarness } from './pi-harness'

describe('Pi Harness', () => {
  test('只读任务不插入验证回合', () => {
    const harness = createPiHarness({ userPrompt: '解释这个项目的架构' })
    harness.recordToolCall({ name: 'read', input: { path: 'src/index.ts' } })
    harness.recordToolCall({ name: 'grep', input: { pattern: 'main' } })
    expect(harness.createFollowUpPrompt()).toBeUndefined()
  })

  test('源码编辑后要求一次最小验证且不重复', () => {
    const harness = createPiHarness({ userPrompt: '修复 parser 的类型报错' })
    harness.recordToolCall({ name: 'Read', input: { path: 'src/parser.ts' } })
    harness.recordToolCall({ name: 'Edit', input: { path: 'src/parser.ts' } })

    expect(harness.createFollowUpPrompt()).toContain('最小验证')
    expect(harness.createFollowUpPrompt()).toBeUndefined()
  })

  test('文档写入后要求回读和格式核验', () => {
    const harness = createPiHarness({ userPrompt: '更新 README' })
    harness.recordToolCall({ name: 'write', input: { path: 'README.md' } })
    expect(harness.createFollowUpPrompt()).toContain('重新读取')
  })

  test('Bash 或 PowerShell 在本地修改后视为已尝试验证', () => {
    for (const toolName of ['bash', 'Bash', 'PowerShell']) {
      const harness = createPiHarness({ userPrompt: '改一处 TypeScript' })
      harness.recordToolCall({ name: 'edit', input: { path: 'src/example.ts' } })
      harness.recordToolCall({ name: toolName, input: { command: 'npx tsc --noEmit' } })
      expect(harness.createFollowUpPrompt()).toBeUndefined()
    }
  })

  test('阻塞或终态失败后不插入恢复回合', () => {
    const blocked = createPiHarness({ userPrompt: '修复错误' })
    blocked.recordToolCall({ name: 'edit', input: { path: 'src/example.ts' } })
    blocked.markBlocked()
    expect(blocked.createFollowUpPrompt()).toBeUndefined()

    const failed = createPiHarness({ userPrompt: '修复错误' })
    failed.recordToolCall({ name: 'write', input: { path: 'src/example.ts' } })
    failed.markTerminalFailure()
    expect(failed.createFollowUpPrompt()).toBeUndefined()
  })
})
