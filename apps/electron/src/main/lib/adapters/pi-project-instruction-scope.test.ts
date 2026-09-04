import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectInstructionScopeController } from './pi-project-instruction-scope'

let projectRoot = ''

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'profer-project-instruction-scope-'))
  mkdirSync(join(projectRoot, 'src'), { recursive: true })
})

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true })
})

describe('ProjectInstructionScopeController', () => {
  test('legacy CLAUDE.md 激活后不阻塞普通写操作，也不要求创建 AGENTS.md', () => {
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# 用户项目规则\n', 'utf-8')
    const controller = new ProjectInstructionScopeController({
      projectRoot,
      cwd: projectRoot,
      initialSources: [],
    })

    const activation = controller.beforeToolCall({
      toolName: 'read',
      input: { path: join(projectRoot, 'src') },
    })
    expect(activation?.block).toBe(true)
    expect(activation?.reason).not.toContain('创建同目录')
    expect(activation?.reason).not.toContain('迁移')

    const prompt = controller.appendPendingInstructions('base prompt')
    expect(prompt).toContain('# 用户项目规则')
    expect(prompt).toContain('CLAUDE.md / AGENTS.md 仅作为上下文读取')

    const writeDecision = controller.beforeToolCall({
      toolName: 'write',
      input: { path: join(projectRoot, 'src', 'new-file.ts') },
    })
    expect(writeDecision).toBeUndefined()
  })

  test('项目没有指令文件时不改变普通工具调用', () => {
    const controller = new ProjectInstructionScopeController({
      projectRoot,
      cwd: projectRoot,
      initialSources: [],
    })

    expect(controller.beforeToolCall({
      toolName: 'write',
      input: { path: join(projectRoot, 'src', 'new-file.ts') },
    })).toBeUndefined()
  })
})
