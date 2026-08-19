import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sendAgentLocalImage } from './agent-image-output-service'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createFixture(): { root: string; sessionDir: string; authorizedDir: string; outsideDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'profer-agent-image-output-'))
  roots.push(root)
  const sessionDir = join(root, 'session')
  const authorizedDir = join(root, 'authorized')
  const outsideDir = join(root, 'outside')
  mkdirSync(sessionDir)
  mkdirSync(authorizedDir)
  mkdirSync(outsideDir)
  return { root, sessionDir, authorizedDir, outsideDir }
}

function writePng(path: string, extra = Buffer.alloc(0)): void {
  writeFileSync(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), extra]))
}

const contextFor = (fixture: ReturnType<typeof createFixture>) => ({
  agentCwd: fixture.sessionDir,
  allowedRoots: [fixture.authorizedDir],
})

describe('sendAgentLocalImage', () => {
  test('Given an authorized PNG When sending Then it copies the image into the session output directory and returns a marker', async () => {
    const fixture = createFixture()
    const source = join(fixture.authorizedDir, 'diagram.png')
    writePng(source, Buffer.from('test'))

    const result = await sendAgentLocalImage({ path: source }, contextFor(fixture))

    expect(result.marker).toContain('[PROMA_IMAGE_ATTACHMENT:')
    expect(result.image.localPath).toMatch(/agent-output-images[\\/]/)
    expect(result.image.filename).toBe('diagram.png')
    expect(result.image.mediaType).toBe('image/png')
    expect(existsSync(result.image.absolutePath)).toBe(true)
  })

  test('Given an image in the session cwd When sending Then it is accepted even when not duplicated in allowedRoots', async () => {
    const fixture = createFixture()
    const source = join(fixture.sessionDir, 'local.gif')
    writeFileSync(source, Buffer.from('GIF89a'))

    const result = await sendAgentLocalImage({ path: source }, contextFor(fixture))

    expect(result.image.mediaType).toBe('image/gif')
  })

  test('Given a relative image path When sending Then it resolves relative to the Agent session cwd', async () => {
    const fixture = createFixture()
    const source = join(fixture.sessionDir, 'relative.webp')
    writeFileSync(source, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))

    const result = await sendAgentLocalImage({ path: 'relative.webp' }, contextFor(fixture))

    expect(result.image.mediaType).toBe('image/webp')
    expect(existsSync(result.image.absolutePath)).toBe(true)
  })

  test('Given a file outside authorized roots When sending Then it rejects without creating an output copy', async () => {
    const fixture = createFixture()
    const source = join(fixture.outsideDir, 'secret.png')
    writePng(source)

    await expect(sendAgentLocalImage({ path: source }, contextFor(fixture))).rejects.toThrow(/授权目录/)
    expect(existsSync(join(fixture.sessionDir, '.context', 'agent-output-images'))).toBe(false)
  })

  test('Given a file that only looks like a PNG When sending Then it rejects its unsupported bytes', async () => {
    const fixture = createFixture()
    const source = join(fixture.authorizedDir, 'pretend.png')
    writeFileSync(source, '<svg xmlns="http://www.w3.org/2000/svg"/>')

    await expect(sendAgentLocalImage({ path: source }, contextFor(fixture))).rejects.toThrow(/不支持.*图片/)
  })

  test('Given an oversized valid image When sending Then it rejects it before copying', async () => {
    const fixture = createFixture()
    const source = join(fixture.authorizedDir, 'large.png')
    writePng(source, Buffer.alloc(20 * 1024 * 1024))

    await expect(sendAgentLocalImage({ path: source }, contextFor(fixture))).rejects.toThrow(/20MB/)
  })

  test('Given a symlink in an authorized root that resolves outside it When sending Then it rejects the path', async () => {
    const fixture = createFixture()
    const outsideImage = join(fixture.outsideDir, 'secret.png')
    writePng(outsideImage)
    const linked = join(fixture.authorizedDir, 'escape.png')

    try {
      symlinkSync(outsideImage, linked, 'file')
    } catch (error) {
      // Windows developer-mode/privilege policy may deny symlinks. Other tests retain traversal coverage.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }

    await expect(sendAgentLocalImage({ path: linked }, contextFor(fixture))).rejects.toThrow(/授权目录/)
  })
})
