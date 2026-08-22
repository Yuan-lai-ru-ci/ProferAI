import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

mock.module('electron', () => ({
  app: { getPath: () => '', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
}))

const calls: unknown[] = []
let providerResult: { ok: true; bytes: Buffer; mediaType: 'image/png'; mode: 'official' } | { ok: false; error: string } | undefined

const { generateAgentGptImage, __setAgentGptImageProviderForTest } = await import('./agent-gpt-image-service')
const { createImageGenerationRecord, transitionImageGenerationRecord, listImageGenerationCards } = await import('./agent-image-generation-records')
const roots: string[] = []
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

afterEach(() => {
  calls.splice(0)
  providerResult = undefined
  __setAgentGptImageProviderForTest(async (input) => {
    calls.push(input)
    if (!providerResult) throw new Error('provider result was not configured')
    return providerResult
  })
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { root: string; session: string; authorized: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), 'profer-agent-gpt-image-'))
  roots.push(root)
  const session = join(root, 'session')
  const authorized = join(root, 'authorized')
  const outside = join(root, 'outside')
  mkdirSync(session); mkdirSync(authorized); mkdirSync(outside)
  return { root, session, authorized, outside }
}

function context(f: ReturnType<typeof fixture>) { return { sessionId: 'session-1', agentCwd: f.session, allowedRoots: [f.authorized] } }

function success() { return { ok: true as const, bytes: png, mediaType: 'image/png' as const, mode: 'official' as const } }

// Initialize the provider before the first test; afterEach intentionally preserves the test seam.
__setAgentGptImageProviderForTest(async (input) => {
  calls.push(input)
  if (!providerResult) throw new Error('provider result was not configured')
  return providerResult
})

describe('generateAgentGptImage', () => {
  test('accepts relative authorized reference, delegates it, and writes a session marker artifact', async () => {
    const f = fixture()
    writeFileSync(join(f.session, 'reference.png'), png)
    providerResult = success()

    const result = await generateAgentGptImage({ toolCallId: 'tool-1', prompt: 'make it blue', referenceImagePaths: ['reference.png'] }, context(f))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(calls).toHaveLength(1)
    expect((calls[0] as { references: unknown[] }).references).toHaveLength(1)
    expect(result.output.marker).toContain('PROMA_IMAGE_ATTACHMENT')
    expect(result.output.image.absolutePath).toContain('agent-output-images')
    expect(existsSync(result.output.image.absolutePath)).toBe(true)
  })

  test('accepts an explicitly authorized additional root but rejects outside, directory and escaping symlink before provider call', async () => {
    const f = fixture()
    providerResult = success()
    const allowed = join(f.authorized, 'allowed.png')
    writeFileSync(allowed, png)
    await expect(generateAgentGptImage({ toolCallId: 'a', prompt: 'x', referenceImagePaths: [allowed] }, context(f))).resolves.toMatchObject({ ok: true })

    calls.splice(0)
    const outside = join(f.outside, 'secret.png')
    writeFileSync(outside, png)
    await expect(generateAgentGptImage({ toolCallId: 'b', prompt: 'x', referenceImagePaths: [outside] }, context(f))).resolves.toMatchObject({ ok: false, error: expect.stringContaining('授权目录') })
    await expect(generateAgentGptImage({ toolCallId: 'c', prompt: 'x', referenceImagePaths: [f.authorized] }, context(f))).resolves.toMatchObject({ ok: false, error: expect.stringContaining('普通文件') })
    try {
      symlinkSync(outside, join(f.authorized, 'escape.png'), 'file')
      await expect(generateAgentGptImage({ toolCallId: 'd', prompt: 'x', referenceImagePaths: [join(f.authorized, 'escape.png')] }, context(f))).resolves.toMatchObject({ ok: false, error: expect.stringContaining('授权目录') })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }
    expect(calls).toHaveLength(0)
  })

  test('rejects spoofed/oversized images and more than four references before provider request', async () => {
    const f = fixture()
    providerResult = success()
    const fake = join(f.session, 'fake.png')
    const large = join(f.session, 'large.png')
    writeFileSync(fake, '<svg/>')
    writeFileSync(large, Buffer.concat([png, Buffer.alloc(20 * 1024 * 1024)]))
    await expect(generateAgentGptImage({ toolCallId: 'fake', prompt: 'x', referenceImagePaths: ['fake.png'] }, context(f))).resolves.toMatchObject({ ok: false, error: expect.stringContaining('不支持') })
    await expect(generateAgentGptImage({ toolCallId: 'large', prompt: 'x', referenceImagePaths: ['large.png'] }, context(f))).resolves.toMatchObject({ ok: false, error: expect.stringContaining('20MB') })
    await expect(generateAgentGptImage({ toolCallId: 'many', prompt: 'x', referenceImagePaths: ['1', '2', '3', '4', '5'] }, context(f))).resolves.toMatchObject({ ok: false, error: expect.stringContaining('最多') })
    expect(calls).toHaveLength(0)
  })

  test('provider failures do not create an output directory or marker', async () => {
    const f = fixture()
    providerResult = { ok: false as const, error: 'upstream rejected' }
    const updates: string[] = []
    const result = await generateAgentGptImage({ toolCallId: 'failed', prompt: 'x' }, { ...context(f), onGenerationUpdate: (record) => updates.push(record.status) })
    expect(result).toMatchObject({ ok: false, error: 'upstream rejected' })
    expect(updates).toEqual(['requesting', 'failed'])
    expect(existsSync(join(f.session, '.context', 'agent-output-images'))).toBe(false)
  })

  test('emits honest requesting, saving and succeeded cards only after durable transitions', async () => {
    const f = fixture()
    providerResult = success()
    const updates: Array<{ status: string; chargedCredits?: number; localPath?: string }> = []
    const result = await generateAgentGptImage({ toolCallId: 'life', prompt: 'blue rocket' }, {
      ...context(f), onGenerationUpdate: (record) => updates.push({ status: record.status, chargedCredits: record.chargedCredits, localPath: record.image?.localPath }),
    })
    expect(result).toMatchObject({ ok: true })
    expect(updates.map((item) => item.status)).toEqual(['requesting', 'saving', 'succeeded'])
    expect(updates[2]).toMatchObject({ chargedCredits: 5, localPath: expect.stringContaining('agent-output-images') })
  })

  test('uses only the latest successful artifact from this session for last-generated editing', async () => {
    const f = fixture()
    const first = await createImageGenerationRecord({ ...context(f), toolCallId: 'prior', prompt: 'prior', reference: { kind: 'none' } })
    await transitionImageGenerationRecord(context(f), first.id, { status: 'saving' })
    const priorPath = join(f.session, '.context', 'agent-output-images', 'prior.png')
    mkdirSync(join(f.session, '.context', 'agent-output-images'), { recursive: true })
    writeFileSync(priorPath, png)
    await transitionImageGenerationRecord(context(f), first.id, { status: 'succeeded', image: { localPath: priorPath, filename: 'prior.png', mediaType: 'image/png' } })
    providerResult = success()

    const result = await generateAgentGptImage({ toolCallId: 'edit', prompt: 'make it green', useLastGeneratedImage: true }, context(f))
    expect(result).toMatchObject({ ok: true, edited: true })
    expect((calls[0] as { references: unknown[] }).references).toHaveLength(1)
    const cards = await listImageGenerationCards(context(f))
    expect(cards.at(-1)).toMatchObject({ reference: { kind: 'last_generated' } })
  })

  test('rejects missing or conflicting last-generated reference before provider contact', async () => {
    const f = fixture()
    providerResult = success()
    await expect(generateAgentGptImage({ toolCallId: 'none', prompt: 'x', useLastGeneratedImage: true }, context(f))).resolves.toMatchObject({ ok: false, error: expect.stringContaining('没有') })
    await expect(generateAgentGptImage({ toolCallId: 'both', prompt: 'x', useLastGeneratedImage: true, referenceImagePaths: ['x.png'] }, context(f))).resolves.toMatchObject({ ok: false, error: expect.stringContaining('不能') })
    expect(calls).toHaveLength(0)
  })
})
