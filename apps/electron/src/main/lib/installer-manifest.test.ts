import { afterEach, describe, expect, test } from 'bun:test'
import {
  BUILTIN_INSTALLER_FALLBACK,
  fetchInstallerManifest,
  findInstallerSource,
} from './installer-manifest'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('内置 fallback 清单', () => {
  test('每条都带可校验的 sha256、正整数大小与安全文件名', () => {
    expect(BUILTIN_INSTALLER_FALLBACK.installers.length).toBeGreaterThanOrEqual(6)
    for (const source of BUILTIN_INSTALLER_FALLBACK.installers) {
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(Number.isInteger(source.sizeBytes)).toBe(true)
      expect(source.sizeBytes).toBeGreaterThan(0)
      expect(source.filename).not.toContain('/')
      expect(source.filename).not.toContain('\\')
      expect(source.fallbackUrl.startsWith('https://')).toBe(true)
    }
  })

  test('覆盖 Windows 与 macOS 的 Git/Node 条目', () => {
    const keys = BUILTIN_INSTALLER_FALLBACK.installers.map((s) => `${s.id}:${s.platform}:${s.arch}`)
    expect(keys).toContain('git-for-windows:win32:x64')
    expect(keys).toContain('git-for-windows:win32:arm64')
    expect(keys).toContain('nodejs:win32:x64')
    expect(keys).toContain('nodejs:win32:arm64')
    expect(keys).toContain('nodejs:darwin:arm64')
    expect(keys).toContain('nodejs:darwin:x64')
  })

  test('版本与分发源站一致（Git 2.54.0 / Node.js 22.22.2）', () => {
    const git = findInstallerSource(BUILTIN_INSTALLER_FALLBACK, 'git-for-windows', 'x64', 'win32')
    const node = findInstallerSource(BUILTIN_INSTALLER_FALLBACK, 'nodejs', 'arm64', 'darwin')
    expect(git?.version).toBe('2.54.0')
    expect(node?.version).toBe('22.22.2')
  })
})

describe('fetchInstallerManifest', () => {
  test('远程清单成功时用远程条目，并补齐本地缺少的平台', async () => {
    globalThis.fetch = (async () => response({
      installers: [{
        id: 'nodejs',
        platform: 'win32',
        arch: 'x64',
        version: '9.9.9',
        downloadUrl: 'https://cdn.example.test/node.msi',
        fallbackUrl: 'https://nodejs.org/dist/v9.9.9/node-v9.9.9-x64.msi',
        sha256: 'a'.repeat(64),
        sizeBytes: 1024,
        filename: 'node-v9.9.9-x64.msi',
      }],
    })) as unknown as typeof fetch

    const manifest = await fetchInstallerManifest(true)
    const remote = manifest.installers.find((s) => s.id === 'nodejs' && s.platform === 'win32' && s.arch === 'x64')
    expect(remote?.version).toBe('9.9.9')
    // macOS 条目由内置 fallback 补齐
    expect(manifest.installers.some((s) => s.platform === 'darwin')).toBe(true)
  })

  test('远程不可用时回退内置清单', async () => {
    globalThis.fetch = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch

    const manifest = await fetchInstallerManifest(true)
    expect(manifest.installers).toEqual(BUILTIN_INSTALLER_FALLBACK.installers)
  })

  test('远程格式非法时同样回退，不抛错', async () => {
    globalThis.fetch = (async () => response({ installers: 'nope' })) as unknown as typeof fetch
    const manifest = await fetchInstallerManifest(true)
    expect(manifest.installers).toEqual(BUILTIN_INSTALLER_FALLBACK.installers)
  })
})
