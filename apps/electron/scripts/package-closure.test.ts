import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const appDir = resolve(import.meta.dir, '..')
const repoRoot = resolve(appDir, '../..')

async function read(path: string): Promise<string> {
  return Bun.file(path).text()
}

function extractPiExternals(command: string): string[] {
  return [...command.matchAll(/--external:(@earendil-works\/[^\s"']+)/g)]
    .map((match) => match[1])
    .sort()
}

describe('最小 Pi 打包闭包', () => {
  test('electron-builder 解包 Pi runtime 的全部 native scopes，同时保留 Profer 契约', async () => {
    const builder = await read(join(appDir, 'electron-builder.yml'))

    for (const pattern of [
      'node_modules/@silvia-odwyer/**',
      'node_modules/@mariozechner/**',
      'node_modules/@napi-rs/**',
      'node_modules/@earendil-works/pi-tui/native/**',
    ]) {
      expect(builder).toContain(`- "${pattern}"`)
    }
    expect(builder).toContain('appId: com.profer.app')
    expect(builder).toContain('afterPack: scripts/after-pack.cjs')
  })

  test('legacy 发布入口在 builder 前同步 runtime closure，且 Pi external 与标准构建一致', async () => {
    const manifest = await Bun.file(join(appDir, 'package.json')).json() as {
      scripts: Record<string, string>
    }
    const standardExternals = extractPiExternals(manifest.scripts['build:main'])
    expect(standardExternals.length).toBeGreaterThan(0)

    for (const relativePath of ['scripts/push-release.cjs', 'scripts/push-release.sh']) {
      const source = await read(join(repoRoot, relativePath))
      const syncIndex = source.indexOf('sync:runtime-deps')
      const builderIndex = source.indexOf('electron-builder')
      expect(syncIndex).toBeGreaterThan(-1)
      expect(builderIndex).toBeGreaterThan(syncIndex)
      expect(extractPiExternals(source)).toEqual(standardExternals)
    }
  })

  test('packaged probe 为 ESM-only Pi package 解析 import export，而非 CJS require', async () => {
    const probe = require('./packaged-pi-probe.cjs') as {
      resolvePackageImportEntry(appArchive: string, packageName: string): string
    }
    const root = mkdtempSync(join(tmpdir(), 'profer-pi-esm-probe-'))
    try {
      const packageDir = join(root, 'node_modules', '@earendil-works', 'pi-ai')
      mkdirSync(packageDir, { recursive: true })
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
        type: 'module',
        exports: { '.': { import: './dist/index.js' } },
      }))

      expect(probe.resolvePackageImportEntry(root, '@earendil-works/pi-ai'))
        .toBe(join(packageDir, 'dist/index.js'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('packaged probe 只接受 app.asar.unpacked 中支持 scope 的 native 文件', async () => {
    const probe = require('./packaged-pi-probe.cjs') as {
      findUnpackedNativeFiles(root: string): string[]
    }
    const root = mkdtempSync(join(tmpdir(), 'profer-pi-probe-'))
    try {
      const allowed = join(root, '@napi-rs', 'image', 'binding.node')
      const ignored = join(root, 'other', 'binding.node')
      mkdirSync(join(allowed, '..'), { recursive: true })
      mkdirSync(join(ignored, '..'), { recursive: true })
      writeFileSync(allowed, '')
      writeFileSync(ignored, '')

      expect(probe.findUnpackedNativeFiles(root)).toEqual([allowed])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
