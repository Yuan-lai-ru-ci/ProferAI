import { describe, expect, test } from 'bun:test'
import { createPiHarness, createPiHarnessFollowUpSystemMessage } from './pi-harness'

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

  test('依赖安装/更新类命令不算验证尝试', () => {
    for (const command of ['npm install', 'bun install', 'pnpm add left-pad', 'yarn upgrade', 'npm install vitest']) {
      const harness = createPiHarness({ userPrompt: '修改代码' })
      harness.recordToolCall({ name: 'edit', input: { path: 'src/example.ts' } })
      harness.recordToolCall({ name: 'bash', input: { command } })
      expect(harness.createFollowUpPrompt()).toContain('最小验证')
    }
  })

  test('不引用写入路径的全仓 build 不算验证尝试', () => {
    const harness = createPiHarness({ userPrompt: '修改代码' })
    harness.recordToolCall({ name: 'edit', input: { path: 'src/example.ts' } })
    harness.recordToolCall({ name: 'bash', input: { command: 'bun run build' } })
    expect(harness.createFollowUpPrompt()).toContain('src/example.ts')
  })

  test('引用写入路径的命令视为定向验证', () => {
    const harness = createPiHarness({ userPrompt: '修改代码' })
    harness.recordToolCall({ name: 'edit', input: { path: 'src/example.ts' } })
    harness.recordToolCall({ name: 'bash', input: { command: 'node scripts/check.mjs src/example.ts' } })
    expect(harness.createFollowUpPrompt()).toBeUndefined()
    expect(harness.createDecision()).toMatchObject({ action: 'none', reason: 'validated', validationAttempted: true })
  })

  test('验证语义命令（typecheck/test/lint）仍视为已尝试验证', () => {
    for (const command of ['npx tsc --noEmit', 'bun test', 'npm run typecheck', 'npx eslint src', 'python -m pytest']) {
      const harness = createPiHarness({ userPrompt: '修改代码' })
      harness.recordToolCall({ name: 'edit', input: { path: 'src/example.ts' } })
      harness.recordToolCall({ name: 'bash', input: { command } })
      expect(harness.createFollowUpPrompt()).toBeUndefined()
    }
  })

  test('follow-up 系统消息携带未验证文件清单', () => {
    const harness = createPiHarness({ userPrompt: '更新文档' })
    harness.recordToolCall({ name: 'write', input: { path: 'docs/a.md' } })
    harness.createFollowUpPrompt()
    const message = createPiHarnessFollowUpSystemMessage('session-1', harness.createDecision())
    expect(message).toMatchObject({
      type: 'system',
      subtype: 'harness_follow_up',
      session_id: 'session-1',
      pending_paths: ['docs/a.md'],
    })
  })

  test('路径字段枚举兜底 file_path/filePath 等写法', () => {
    const harness = createPiHarness({ userPrompt: '修改代码' })
    harness.recordToolCall({ name: 'edit', input: { file_path: 'src/a.ts' } })
    harness.recordToolCall({ name: 'read', input: { filePath: 'src/a.ts' } })
    expect(harness.createFollowUpPrompt()).toBeUndefined()
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

  test('源码写入后读回同一文件视为最小验证（与系统提示词口径一致）', () => {
    const harness = createPiHarness({ userPrompt: '修复 parser 的类型报错' })
    harness.recordToolCall({ name: 'edit', input: { path: 'src/parser.ts' } })
    harness.recordToolCall({ name: 'read', input: { path: 'src/parser.ts' } })
    expect(harness.createFollowUpPrompt()).toBeUndefined()
    expect(harness.createDecision()).toMatchObject({
      action: 'none',
      reason: 'validated',
      pendingPaths: [],
      validationAttempted: false,
    })
  })

  test('先读后写不算读回验证（读回必须发生在写入之后）', () => {
    const harness = createPiHarness({ userPrompt: '修改示例文件' })
    harness.recordToolCall({ name: 'read', input: { path: 'src/a.ts' } })
    harness.recordToolCall({ name: 'edit', input: { path: 'src/a.ts' } })
    const prompt = harness.createFollowUpPrompt()
    expect(prompt).toContain('src/a.ts')
  })

  test('部分读回时 follow-up 只列出未验证文件', () => {
    const harness = createPiHarness({ userPrompt: '更新两份文档' })
    harness.recordToolCall({ name: 'write', input: { path: 'docs/a.md' } })
    harness.recordToolCall({ name: 'write', input: { path: 'docs/b.md' } })
    harness.recordToolCall({ name: 'read', input: { path: 'docs/a.md' } })
    const prompt = harness.createFollowUpPrompt()
    expect(prompt).toContain('docs/b.md')
    expect(prompt).not.toContain('docs/a.md')
  })

  test('相对路径按 cwd 解析后与绝对路径读回匹配', () => {
    const cwd = process.platform === 'win32' ? 'D:\\work\\repo' : '/work/repo'
    const harness = createPiHarness({ userPrompt: '改一处源码', cwd })
    harness.recordToolCall({ name: 'write', input: { path: 'src/a.ts' } })
    harness.recordToolCall({ name: 'read', input: { path: `${cwd}/src/a.ts` } })
    expect(harness.createFollowUpPrompt()).toBeUndefined()
  })

  test.if(process.platform === 'win32')('Windows 路径大小写与分隔符不敏感', () => {
    const harness = createPiHarness({ userPrompt: '改一处源码', cwd: 'D:\\work\\repo' })
    harness.recordToolCall({ name: 'write', input: { path: 'C:\\Work\\Repo\\Src\\A.TS' } })
    harness.recordToolCall({ name: 'read', input: { path: 'c:/work/repo/src/a.ts' } })
    expect(harness.createFollowUpPrompt()).toBeUndefined()
  })
})
