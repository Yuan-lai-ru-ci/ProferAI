import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeckBrief } from '@profer/shared'
import { buildPiPptDeckTools, injectPptDeckMcpServer } from './ppt-deck-agent-tools'
import { createDeckProject } from './ppt-deck-project-service'

interface ClaudeTool {
  name: string
  execute: (input: Record<string, unknown>) => Promise<unknown>
}

function makeBrief(): DeckBrief {
  return {
    schemaVersion: 1,
    deckId: 'governed-tools',
    goal: '解释实验结果',
    audience: '课题组同学',
    occasion: '每周组会',
    durationMinutes: 12,
    slideCount: 4,
    coreClaims: ['双阶段方法降低误差'],
    includedSourceIds: ['src-1'],
    styleId: 'academic-editorial',
    citationPolicy: 'inline_short_notes_full_references',
    speakerNotesPolicy: 'talking_points_transitions_timing_questions',
    state: 'awaiting_confirmation',
  }
}

function createClaudeSdkStub(): { sdk: typeof import('@anthropic-ai/claude-agent-sdk'); tools: ClaudeTool[] } {
  const tools: ClaudeTool[] = []
  const sdk = {
    tool(name: string, _description: string, _schema: unknown, execute: ClaudeTool['execute']) {
      const definition = { name, execute }
      tools.push(definition)
      return definition
    },
    createSdkMcpServer(input: { tools: ClaudeTool[] }) {
      return input
    },
  } as unknown as typeof import('@anthropic-ai/claude-agent-sdk')
  return { sdk, tools }
}

function createPiSdkStub(): { sdk: typeof import('@earendil-works/pi-coding-agent'); tools: Array<ClaudeTool & { label?: string }> } {
  const tools: Array<ClaudeTool & { label?: string }> = []
  const sdk = {
    defineTool(input: ClaudeTool & { label?: string }) {
      tools.push(input)
      return input
    },
  } as unknown as typeof import('@earendil-works/pi-coding-agent')
  return { sdk, tools }
}

describe('ppt deck agent tools', () => {
  test('Claude 与 Pi 注册相同的四个受管工具', async () => {
    const claude = createClaudeSdkStub()
    const mcpServers: Record<string, Record<string, unknown>> = {}
    await injectPptDeckMcpServer(claude.sdk, mcpServers, {
      sessionId: 'session-1',
      agentCwd: tmpdir(),
      allowedRoots: [tmpdir()],
    })

    const pi = createPiSdkStub()
    const piTools = buildPiPptDeckTools(pi.sdk, {
      sessionId: 'session-1',
      agentCwd: tmpdir(),
      allowedRoots: [tmpdir()],
    })

    expect(claude.tools.map((tool) => tool.name)).toEqual([
      'inspect_deck_sources',
      'create_deck_project',
      'confirm_deck_brief',
      'compile_deck_project',
    ])
    expect(piTools.map((tool) => tool.name)).toEqual(claude.tools.map((tool) => tool.name))
    expect(mcpServers['ppt-decks']).toBeDefined()
  })

  test('inspect_deck_sources 只读取 session cwd/allowedRoots，并返回来源状态和 gap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-deck-tools-'))
    try {
      writeFileSync(join(root, 'result-2026-08-24-final.md'), '# 结果\n误差下降 37%')
      const { sdk, tools } = createClaudeSdkStub()
      await injectPptDeckMcpServer(sdk, {}, { sessionId: 's-1', agentCwd: root, allowedRoots: [] })
      const inspect = tools.find((tool) => tool.name === 'inspect_deck_sources')!
      const raw = await inspect.execute({ paths: [root] }) as { content: Array<{ text: string }> }
      const payload = JSON.parse(raw.content[0]!.text) as { sources: Array<{ status: string; relativePath: string; absolutePath?: string }>; gaps: string[] }

      expect(payload.sources[0]?.relativePath).toBe('result-2026-08-24-final.md')
      expect(payload.sources[0]?.status).toBe('current')
      expect(payload.sources[0]?.absolutePath).toBeUndefined()
      expect(payload.gaps).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('create 不会确认项目；confirm 只读取 AskUser 已写入的 receipt，不能接受 confirmed 布尔值', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-deck-tools-'))
    try {
      const { sdk, tools } = createClaudeSdkStub()
      await injectPptDeckMcpServer(sdk, {}, { sessionId: 's-1', agentCwd: root, allowedRoots: [] })
      const create = tools.find((tool) => tool.name === 'create_deck_project')!
      const createdRaw = await create.execute({ brief: makeBrief() }) as { content: Array<{ text: string }> }
      const created = JSON.parse(createdRaw.content[0]!.text) as { projectDir: string; state: string; confirmationToken?: string; confirmation: { armedForSession: boolean } }
      expect(created.state).toBe('awaiting_confirmation')
      expect(created.confirmationToken).toBeUndefined()
      expect(created.confirmation.armedForSession).toBe(true)

      const confirm = tools.find((tool) => tool.name === 'confirm_deck_brief')!
      await expect(confirm.execute({ projectDir: created.projectDir, confirmed: true })).rejects.toThrow('确认')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('compile_deck_project 在未确认项目上先阻断，不调用编译器', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-deck-tools-'))
    try {
      const project = await createDeckProject({ agentCwd: root, brief: makeBrief() })
      const { sdk, tools } = createClaudeSdkStub()
      await injectPptDeckMcpServer(sdk, {}, { sessionId: 's-1', agentCwd: root, allowedRoots: [] })
      const compile = tools.find((tool) => tool.name === 'compile_deck_project')!
      await expect(compile.execute({ projectDir: project.projectDir })).rejects.toThrow('确认')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
