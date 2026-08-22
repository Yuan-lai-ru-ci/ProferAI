import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createImageGenerationRecord,
  getImageGenerationRecordForRetry,
  getLatestSuccessfulGeneration,
  listImageGenerationCards,
  transitionImageGenerationRecord,
} from './agent-image-generation-records'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'profer-image-records-'))
  roots.push(root)
  const session = join(root, 'session')
  mkdirSync(session)
  return { session, context: { sessionId: 'session-1', agentCwd: session } }
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

async function succeeded(f: ReturnType<typeof fixture>) {
  const requesting = await createImageGenerationRecord({
    ...f.context, toolCallId: 'tool-1', prompt: 'blue rocket', reference: { kind: 'none' },
  })
  await transitionImageGenerationRecord(f.context, requesting.id, { status: 'saving' })
  return transitionImageGenerationRecord(f.context, requesting.id, {
    status: 'succeeded', mode: 'official', chargedCredits: 5,
    image: { localPath: join(f.session, '.context', 'agent-output-images', 'a.png'), filename: 'a.png', mediaType: 'image/png' },
  })
}

describe('agent image generation records', () => {
  test('Given a lifecycle, when replayed, then it returns one latest chronological safe card', async () => {
    const f = fixture()
    const record = await succeeded(f)
    const cards = await listImageGenerationCards(f.context)
    expect(cards).toEqual([expect.objectContaining({ id: record.id, status: 'succeeded', chargedCredits: 5 })])
    expect(readFileSync(join(f.session, '.context', 'image-generations.jsonl'), 'utf8').trim().split(/\r?\n/)).toHaveLength(3)
  })

  test('Given malformed or foreign snapshots, when replayed, then valid same-session cards remain', async () => {
    const f = fixture()
    const record = await succeeded(f)
    const path = join(f.session, '.context', 'image-generations.jsonl')
    writeFileSync(path, `${readFileSync(path, 'utf8')}bad json\n${JSON.stringify({ version: 1, id: 'foreign', sessionId: 'other', status: 'requesting' })}\n`)
    expect(await listImageGenerationCards(f.context)).toEqual([expect.objectContaining({ id: record.id })])
  })

  test('Given a direct-path reference, when persisted and returned to UI, then no private path is stored', async () => {
    const f = fixture()
    await createImageGenerationRecord({ ...f.context, toolCallId: 'tool', prompt: 'x', reference: { kind: 'paths' } })
    const [card] = await listImageGenerationCards(f.context)
    const raw = readFileSync(join(f.session, '.context', 'image-generations.jsonl'), 'utf8')
    expect(card).not.toHaveProperty('referencePaths')
    expect(raw).not.toContain('referencePaths')
  })

  test('Given a tampered output path snapshot, when replayed, then it never becomes a card', async () => {
    const f = fixture()
    const path = join(f.session, '.context')
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'image-generations.jsonl'), `${JSON.stringify({
      version: 1, id: 'tampered', sessionId: 'session-1', toolCallId: 't', status: 'succeeded', prompt: 'x', size: 'auto', quality: 'auto', reference: { kind: 'none' },
      image: { localPath: join(f.session, '..', 'outside.png'), filename: 'outside.png', mediaType: 'image/png' }, createdAt: 1, updatedAt: 1,
    })}\n`)
    expect(await listImageGenerationCards(f.context)).toEqual([])
  })

  test('Given failed and successful records, when queried, then retry and latest-success respect terminal state', async () => {
    const f = fixture()
    const success = await succeeded(f)
    const failed = await createImageGenerationRecord({ ...f.context, toolCallId: 'tool-failed', prompt: 'fail', reference: { kind: 'none' } })
    await transitionImageGenerationRecord(f.context, failed.id, { status: 'failed', error: 'nope' })
    expect((await getLatestSuccessfulGeneration(f.context))?.id).toBe(success.id)
    expect((await getImageGenerationRecordForRetry(f.context, failed.id))?.status).toBe('failed')
    await expect(transitionImageGenerationRecord(f.context, success.id, { status: 'saving' })).rejects.toThrow('状态转换')
  })
})
