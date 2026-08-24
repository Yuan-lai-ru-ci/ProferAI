import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeckBrief } from '@profer/shared'
import { createDeckProject, getDeckBriefConfirmationToken, readDeckProject } from './ppt-deck-project-service'
import { AgentAskUserService } from './agent-ask-user-service'

const tempRoots: string[] = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeBrief(): DeckBrief {
  return {
    schemaVersion: 1,
    deckId: 'ask-user-deck',
    goal: '确认组会叙事',
    audience: '课题组同学',
    occasion: '每周组会',
    durationMinutes: 10,
    slideCount: 4,
    coreClaims: ['方法有效'],
    includedSourceIds: ['src-1'],
    styleId: 'academic-editorial',
    citationPolicy: 'inline_short_notes_full_references',
    speakerNotesPolicy: 'talking_points_transitions_timing_questions',
    state: 'awaiting_confirmation',
  }
}

describe('AgentAskUserService', () => {
  test('Given the renderer answers synchronously When notifying it of a question Then the answer resolves the pending request', async () => {
    const service = new AgentAskUserService()
    const controller = new AbortController()

    const result = service.handleAskUserQuestion(
      'session-1',
      { questions: [{ question: 'Continue?' }] },
      controller.signal,
      (request) => {
        void service.respondToAskUser(request.requestId, { 'Continue?': 'Yes' }).then((sessionId) => {
          expect(sessionId).toBe('session-1')
        })
      },
    )

    await expect(result).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: [{ question: 'Continue?' }],
        answers: { 'Continue?': 'Yes' },
      },
    })
    expect(service.getPendingRequests()).toEqual([])
  })

  test('Deck Brief 选择精确确认项时由主进程写入 receipt，renderer request 不含 token/path metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-ask-user-'))
    tempRoots.push(root)
    const project = await createDeckProject({ agentCwd: root, brief: makeBrief() })
    const token = await getDeckBriefConfirmationToken(project.projectDir)
    const service = new AgentAskUserService()
    const controller = new AbortController()
    let requestId = ''

    const result = service.handleAskUserQuestion(
      'session-confirm',
      {
        questions: [{ question: '请确认 Deck Brief', options: [{ label: '确认 Deck Brief' }, { label: '修改方向' }] }],
        proferConfirmation: { kind: 'deck-brief', projectDir: project.projectDir, confirmationToken: token },
      },
      controller.signal,
      (request) => {
        requestId = request.requestId
        expect(request.proferConfirmation).toBeUndefined()
        expect(JSON.stringify(request)).not.toContain(token)
        expect(JSON.stringify(request)).not.toContain(project.projectDir)
        void service.respondToAskUser(request.requestId, { '请确认 Deck Brief': '确认 Deck Brief' })
      },
    )

    await expect(result).resolves.toMatchObject({ behavior: 'allow' })
    expect(requestId).toBeString()
    await expect(readDeckProject(project.projectDir)).resolves.toMatchObject({ brief: { state: 'confirmed' } })
  })

  test('选择修改、伪造 token 或 Abort 都不能确认 Brief', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-ask-user-'))
    tempRoots.push(root)
    const project = await createDeckProject({ agentCwd: root, brief: makeBrief() })
    const token = await getDeckBriefConfirmationToken(project.projectDir)
    const service = new AgentAskUserService()

    const modifyController = new AbortController()
    const modifyResult = service.handleAskUserQuestion(
      'session-modify',
      { questions: [{ question: '确认？' }], proferConfirmation: { kind: 'deck-brief', projectDir: project.projectDir, confirmationToken: token } },
      modifyController.signal,
      (request) => { void service.respondToAskUser(request.requestId, { '确认？': '修改方向' }) },
    )
    await expect(modifyResult).resolves.toMatchObject({ behavior: 'allow' })
    expect((await readDeckProject(project.projectDir)).brief.state).toBe('awaiting_confirmation')

    // token 已被消费/替换后，伪造 token 不能完成确认。
    const forgedController = new AbortController()
    const forgedResult = service.handleAskUserQuestion(
      'session-forged',
      { questions: [{ question: '确认？' }], proferConfirmation: { kind: 'deck-brief', projectDir: project.projectDir, confirmationToken: 'A'.repeat(40) } },
      forgedController.signal,
      (request) => { void service.respondToAskUser(request.requestId, { '确认？': '确认 Deck Brief' }) },
    )
    await expect(forgedResult).resolves.toMatchObject({ behavior: 'deny' })
    expect((await readDeckProject(project.projectDir)).brief.state).toBe('awaiting_confirmation')

    const abortController = new AbortController()
    const abortResult = service.handleAskUserQuestion(
      'session-abort',
      { questions: [{ question: '确认？' }], proferConfirmation: { kind: 'deck-brief', projectDir: project.projectDir, confirmationToken: token } },
      abortController.signal,
      () => { abortController.abort() },
    )
    await expect(abortResult).resolves.toMatchObject({ behavior: 'deny' })
    expect((await readDeckProject(project.projectDir)).brief.state).toBe('awaiting_confirmation')
  })
})
