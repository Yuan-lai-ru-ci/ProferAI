import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DeckBrief, DeckSpec } from '@profer/shared'
import {
  assertDeckCompilable,
  createDeckProject,
  getDeckBriefConfirmationToken,
  readDeckProject,
  recordDeckBriefConfirmation,
  writeDeckSpec,
} from './ppt-deck-project-service'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-ppt-project-'))
  roots.push(root)
  return root
}

function brief(overrides: Partial<DeckBrief> = {}): DeckBrief {
  return {
    schemaVersion: 1,
    deckId: 'lab-meeting',
    goal: '解释实验结果',
    audience: '课题组同学',
    occasion: '每周组会',
    durationMinutes: 12,
    slideCount: 5,
    coreClaims: ['双阶段方法降低误差'],
    includedSourceIds: ['src-1'],
    styleId: 'academic-editorial',
    citationPolicy: 'inline_short_notes_full_references',
    speakerNotesPolicy: 'talking_points_transitions_timing_questions',
    state: 'awaiting_confirmation',
    ...overrides,
  }
}

function spec(): DeckSpec {
  return {
    schemaVersion: 1,
    deckId: 'lab-meeting',
    title: '实验结果',
    styleId: 'academic-editorial',
    slides: [{
      slideId: 'result-01',
      claim: '误差下降',
      evidenceRefs: ['src-1#p1'],
      visualRole: 'assertion_evidence',
      layoutIntent: 'editorial_split',
      densityBudget: 'medium',
      editableObjects: ['text', 'chart'],
      content: { headline: '37%' },
      speakerNotes: ['解释结果'],
      citations: ['实验记录'],
    }],
    sourceHashes: { 'src-1': 'a'.repeat(64) },
  }
}

describe('ppt deck project service', () => {
  test('创建完整项目目录，初始状态为 awaiting_confirmation', async () => {
    const root = makeRoot()
    const project = await createDeckProject({ agentCwd: root, brief: brief() })

    expect(project.state).toBe('awaiting_confirmation')
    expect(project.projectDir).toBe(join(root, '.context', 'deck-projects', 'lab-meeting'))
    for (const path of [
      'brief.json', 'context-manifest.json', 'source-lineage.json', 'deck-spec.json',
      'style-pack.json', 'sources.json', 'assets', 'src', 'renders', 'qa', 'output',
    ]) expect(existsSync(join(project.projectDir, path))).toBe(true)

    const storedBrief = JSON.parse(readFileSync(join(project.projectDir, 'brief.json'), 'utf8'))
    expect(storedBrief.state).toBe('awaiting_confirmation')
    expect(storedBrief.confirmationHash).toBeUndefined()
  })

  test('拒绝非法项目 ID 和越界 agentCwd，不把项目写到工作区外', async () => {
    const root = makeRoot()
    await expect(createDeckProject({ agentCwd: root, brief: brief({ deckId: '../outside' }) })).rejects.toThrow('deckId')
    await expect(createDeckProject({ agentCwd: join(root, 'missing'), brief: brief() })).rejects.toThrow('agentCwd')
  })

  test('未确认项目不能编译；确认 token 只返回一次性凭据且磁盘只保存 hash', async () => {
    const root = makeRoot()
    const project = await createDeckProject({ agentCwd: root, brief: brief() })

    await expect(assertDeckCompilable(project.projectDir)).rejects.toThrow('确认')
    const token = await getDeckBriefConfirmationToken(project.projectDir)
    expect(token).toMatch(/^[A-Za-z0-9_-]{32,}$/)
    expect(readFileSync(join(project.projectDir, 'brief.json'), 'utf8')).not.toContain(token)

    await recordDeckBriefConfirmation({ projectDir: project.projectDir, confirmationToken: token, requestId: 'req-001' })
    const snapshot = await readDeckProject(project.projectDir)
    expect(snapshot.brief.state).toBe('confirmed')
    expect(snapshot.brief.confirmedAt).toBeString()
    expect(snapshot.brief.confirmationHash).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.brief.confirmedByRequestId).toBe('req-001')
    await expect(assertDeckCompilable(project.projectDir)).resolves.toBeDefined()
  })

  test('修改 Brief 后旧确认立即失效，必须重新确认', async () => {
    const root = makeRoot()
    const project = await createDeckProject({ agentCwd: root, brief: brief() })
    const token = await getDeckBriefConfirmationToken(project.projectDir)
    await recordDeckBriefConfirmation({ projectDir: project.projectDir, confirmationToken: token, requestId: 'req-001' })

    const changed = brief({ state: 'confirmed', goal: '改成解释失败案例', confirmedAt: new Date().toISOString(), confirmationHash: 'a'.repeat(64), confirmedByRequestId: 'forged' })
    writeFileSync(join(project.projectDir, 'brief.json'), JSON.stringify(changed, null, 2), 'utf8')

    await expect(assertDeckCompilable(project.projectDir)).rejects.toThrow('确认')
    await expect(recordDeckBriefConfirmation({ projectDir: project.projectDir, confirmationToken: token, requestId: 'req-002' })).rejects.toThrow('token')
  })

  test('写入 Deck Spec 后仍绑定同一 deckId，损坏 JSON/缺文件返回结构化错误', async () => {
    const root = makeRoot()
    const project = await createDeckProject({ agentCwd: root, brief: brief() })
    await expect(writeDeckSpec(project.projectDir, spec())).resolves.toBeUndefined()
    expect(JSON.parse(readFileSync(join(project.projectDir, 'deck-spec.json'), 'utf8')).deckId).toBe('lab-meeting')
    await expect(writeDeckSpec(project.projectDir, { ...spec(), deckId: 'other-deck' })).rejects.toThrow('deckId')

    writeFileSync(join(project.projectDir, 'brief.json'), '{broken', 'utf8')
    await expect(readDeckProject(project.projectDir)).rejects.toMatchObject({
      code: 'DECK_PROJECT_INVALID_JSON',
      file: 'brief.json',
    })

    rmSync(join(project.projectDir, 'deck-spec.json'))
    await expect(assertDeckCompilable(project.projectDir)).rejects.toMatchObject({
      code: 'DECK_PROJECT_MISSING_FILE',
      file: 'deck-spec.json',
    })
  })

  test('拒绝越界 projectDir，不因路径不存在而静默新建项目', async () => {
    const root = makeRoot()
    await expect(readDeckProject(resolve(root, '..'))).rejects.toMatchObject({ code: 'DECK_PROJECT_PATH_FORBIDDEN' })
  })
})
