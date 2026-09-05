import { describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// skin-service 经 config-paths 导入 Electron；manifest 单测只需最小主进程 mock。
mock.module('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false },
  net: {},
}))

const { parseSkinManifestText, readManifest } = await import('./skin-service')

function withSkinManifest(manifest: object, run: (dir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'profer-skin-manifest-'))
  const id = (manifest as { id?: unknown }).id
  if (typeof id !== 'string') throw new Error('测试 manifest 必须提供字符串 id')
  const dir = join(root, id)
  mkdirSync(dir)
  try {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8')
    run(dir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('皮肤 manifest Surface Contract 版本', () => {
  test('未声明 contractVersion 的 v1 皮肤继续被解析并归一为 v1', () => {
    const parsed = parseSkinManifestText('{"id":"legacy-skin","tone":"dark"}')
    expect(parsed.ok).toBe(true)

    withSkinManifest({ id: 'legacy-skin', name: 'Legacy skin', tone: 'dark' }, (dir) => {
      expect(readManifest(dir, false)).toMatchObject({
        id: 'legacy-skin',
        tone: 'dark',
        contractVersion: 1,
        builtin: false,
      })
    })
  })

  test('声明 contractVersion 2 的皮肤将其传入注册表', () => {
    withSkinManifest({ id: 'v2-skin', name: 'V2 skin', tone: 'light', contractVersion: 2 }, (dir) => {
      expect(readManifest(dir, true)).toMatchObject({
        id: 'v2-skin',
        tone: 'light',
        contractVersion: 2,
        builtin: true,
      })
    })
  })

  test.each([0, 1, -1, 1.5, '2', null])('无效 contractVersion %p 按 v1 兼容', (contractVersion) => {
    withSkinManifest({ id: 'compat-skin', name: 'Compat skin', tone: 'dark', contractVersion }, (dir) => {
      expect(readManifest(dir, false)?.contractVersion).toBe(1)
    })
  })
})
